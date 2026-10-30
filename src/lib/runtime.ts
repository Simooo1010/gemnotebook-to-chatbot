// Runtime composition (server only): wires vault, throttle, usage counters, audit, Google client and notebook operations.
// Nothing here touches the network or storage at import time; everything is built on first use and cached on globalThis.
import { createGoogleClient, type AuditSink } from "@/lib/google/client";
import type { FetchLike } from "@/lib/google/http";
import { MemoryAuditSink, SupabaseAuditSink, SupabaseUsageCounter } from "@/lib/google/supabase";
import { MemoryUsageCounter, createThrottle, type UsageCounter } from "@/lib/google/throttle";
import { getCreatedObjects, type CreatedObjects } from "@/lib/notebooklm/created";
import { createNotebookOps, type NotebookOps } from "@/lib/notebooklm/notebooks";
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
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

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
  const throttle = createThrottle({ usage: p.usage, now: p.now, sleep: p.sleep });
  const client = createGoogleClient({
    fetch: p.fetch ?? ((url, init) => fetch(url, init)),
    vault: p.vault,
    accounts: { setStatus: (id, status) => (status === "needs_reauth" ? p.vault.markNeedsReauth(id) : Promise.resolve()) },
    throttle,
    audit: p.audit,
    config: { base: resolveNotebookBaseUrl(p.env), rpcOverridesJson },
    now: p.now,
  });
  const notebooks = createNotebookOps({ client, created: p.created, rpcOverridesJson, now: p.now });
  return { listAccounts: () => p.vault.listAccounts(), notebooks };
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
