// Runtime composition (server only): wires vault, throttle, usage counters, audit, Google client and notebook operations.
// Nothing here touches the network or storage at import time; everything is built on first use and cached on globalThis.
import { createGoogleClient, type AuditSink } from "@/lib/google/client";
import type { FetchLike } from "@/lib/google/http";
import { MemoryAuditSink, SupabaseAuditSink, SupabaseUsageCounter } from "@/lib/google/supabase";
import { MemoryUsageCounter, createThrottle, type UsageCounter } from "@/lib/google/throttle";
import { getCreatedObjects, type CreatedObjects } from "@/lib/notebooklm/created";
import { createNotebookOps, type NotebookOps } from "@/lib/notebooklm/notebooks";
import { createMediaDownloader, type MediaDownloader } from "@/lib/notebooklm/media-download";
import { deriveMediaKey, mediaUrl, signMediaToken, type MediaKind } from "@/lib/notebooklm/media-link";
import { createSourceOps, type SourceOps } from "@/lib/notebooklm/sources";
import { createStudioOps, type StudioOps } from "@/lib/notebooklm/studio";
import { getVault } from "@/lib/vault";
import { createServiceDb } from "@/lib/vault/supabase";
import type { Account } from "@/lib/vault/storage";
import type { Vault } from "@/lib/vault/vault";

if (typeof window !== "undefined") {
  throw new Error("runtime must never be imported into client code");
}

type Env = Record<string, string | undefined>;

export const DEFAULT_NOTEBOOKLM_BASE_URL = "https://notebook.google.com";

/** What the MCP tools need. Tests supply a fake. */
export interface ToolRuntime {
  listAccounts(): Promise<Account[]>;
  notebooks: NotebookOps;
  sources: SourceOps;
  studio: StudioOps;
  /** Signed download links (needs OAUTH_SIGNING_KEY and PUBLIC_BASE_URL; throws RuntimeConfigError / MediaLinkConfigError otherwise). */
  links: MediaLinks;
  /** Used by GET /api/media/<token>. */
  media: MediaDownloader;
}

export interface MediaLinks {
  create(a: { accountId: string; notebookId: string; artifactId: string; kind: MediaKind; ttlSeconds?: number }): { url: string; expiresAt: Date };
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Public https origin of this deployment (PUBLIC_BASE_URL). Links are only handed out when it is set. */
export function resolvePublicBaseUrl(env: Env): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  let u: URL | null = null;
  try {
    u = raw ? new URL(raw) : null;
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)))) {
    throw new RuntimeConfigError("PUBLIC_BASE_URL must be set to the public https address of this deployment");
  }
  return u.origin;
}

export function resolveNotebookBaseUrl(env: Env): string {
  const raw = has(env.NOTEBOOKLM_BASE_URL) ? env.NOTEBOOKLM_BASE_URL!.trim() : DEFAULT_NOTEBOOKLM_BASE_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RuntimeConfigError("NOTEBOOKLM_BASE_URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new RuntimeConfigError("NOTEBOOKLM_BASE_URL must be an https URL");
  return u.origin;
}

/** Usage counters and audit rows: Supabase when configured; memory only outside production; otherwise fail closed. */
export function createUsageAndAuditFromEnv(env: Env): { usage: UsageCounter; audit: AuditSink } {
  const url = has(env.SUPABASE_URL);
  const key = has(env.SUPABASE_SERVICE_ROLE_KEY);
  if (url && key) {
    const db = createServiceDb(env);
    return { usage: new SupabaseUsageCounter(db), audit: new SupabaseAuditSink(db) };
  }
  if (url !== key) throw new RuntimeConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  if (env.NODE_ENV === "production") {
    throw new RuntimeConfigError("usage and audit storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return { usage: new MemoryUsageCounter(), audit: new MemoryAuditSink() };
}

export interface RuntimeParts {
  env: Env;
  vault: Vault;
  created: CreatedObjects;
  usage: UsageCounter;
  audit: AuditSink;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Pure composition from already-built parts (no globals, no env reads beyond the Google settings). */
export function createRuntime(p: RuntimeParts): ToolRuntime {
  const rpcOverridesJson = has(p.env.NOTEBOOKLM_RPC_OVERRIDES) ? p.env.NOTEBOOKLM_RPC_OVERRIDES! : null;
  const fetchImpl: FetchLike = p.fetch ?? ((url, init) => fetch(url, init));
  const throttle = createThrottle({ usage: p.usage, now: p.now, sleep: p.sleep });
  const client = createGoogleClient({
    fetch: fetchImpl,
    vault: p.vault,
    accounts: { setStatus: (id, status) => (status === "needs_reauth" ? p.vault.markNeedsReauth(id) : Promise.resolve()) },
    throttle,
    audit: p.audit,
    config: { base: resolveNotebookBaseUrl(p.env), rpcOverridesJson },
    now: p.now,
  });
  const notebooks = createNotebookOps({ client, created: p.created, rpcOverridesJson, now: p.now });
  const sources = createSourceOps({ client, created: p.created, notebooks, rpcOverridesJson, now: p.now });
  const studio = createStudioOps({ client, created: p.created, notebooks, rpcOverridesJson, now: p.now });
  const media = createMediaDownloader({ studio, vault: p.vault, throttle, fetch: fetchImpl, audit: p.audit, now: p.now });
  const links: MediaLinks = {
    create(a) {
      const base = resolvePublicBaseUrl(p.env);
      const { token, expiresAt } = signMediaToken(
        deriveMediaKey(p.env),
        { accountId: a.accountId, notebookId: a.notebookId, artifactId: a.artifactId, kind: a.kind },
        { now: p.now ?? Date.now, ttlSeconds: a.ttlSeconds },
      );
      return { url: mediaUrl(base, token), expiresAt: new Date(expiresAt) };
    },
  };
  return { listAccounts: () => p.vault.listAccounts(), notebooks, sources, studio, links, media };
}

const g = globalThis as unknown as { __runtime?: ToolRuntime };

/** Process-wide runtime. Throws (vault/config errors) when production storage is not configured. */
export function getRuntime(): ToolRuntime {
  if (!g.__runtime) {
    const { usage, audit } = createUsageAndAuditFromEnv(process.env);
    g.__runtime = createRuntime({ env: process.env, vault: getVault(), created: getCreatedObjects(), usage, audit });
  }
  return g.__runtime;
}
