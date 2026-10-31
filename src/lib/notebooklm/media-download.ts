// Streams a generated overview through our own domain (SPEC §3 Downloads). Two parts:
//  - createMediaDownloader: re-lists the artifact for a FRESH Google URL, then streams it with the account's cookie jar
//    (manual redirects, cookies re-attached per hop, Google hosts only). The Google URL is never stored or returned.
//  - handleMediaRequest: the GET /api/media/<token> logic with injected deps. Every failure before the first byte is a generic
//    answer: no Google URL, cookie, account id or reason detail ever reaches the client or the logs.
import { createHash } from "node:crypto";
import type { AuditSink, ClientVault } from "@/lib/google/client";
import {
  CooldownActiveError,
  DailyCapReachedError,
  RangeNotSatisfiableError,
} from "@/lib/google/errors";
import { fetchMedia, type FetchLike } from "@/lib/google/http";
import type { Throttle } from "@/lib/google/throttle";
import { MEDIA_CONTENT_TYPE, MEDIA_FILENAME, verifyMediaToken, type MediaClaims, type MediaKind } from "./media-link";
import { ArtifactNotDownloadableError, ArtifactNotFoundError, ArtifactNotReadyError, type StudioOps } from "./studio";
import { isVaultError } from "@/lib/vault/vault";

export interface OpenedMedia {
  /** 200 (whole file) or 206 (partial). */
  status: number;
  body: ReadableStream<Uint8Array>;
  kind: MediaKind;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
}

export const URL_MEMO_TTL_MS = 60_000;
export const URL_MEMO_MAX_ENTRIES = 50;

export interface UrlMemo<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  readonly size: number;
}

/**
 * Tiny in-process memo (TTL + size cap) for the resolved fresh media target, so repeated Range requests (Safari) do not each
 * re-list the notebook. Lives in process memory only, never persisted or logged. Expired entries are purged on every access, and an
 * entry is never returned after its TTL. At the cap the oldest entry is evicted.
 */
export function createUrlMemo<V>(opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}): UrlMemo<V> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? URL_MEMO_TTL_MS;
  const max = opts.maxEntries ?? URL_MEMO_MAX_ENTRIES;
  const entries = new Map<string, { value: V; expiresAt: number }>(); // insertion order = age order (set re-inserts)
  const purge = () => {
    const t = now();
    for (const [k, e] of entries) if (e.expiresAt <= t) entries.delete(k);
  };
  return {
    get(key) {
      purge();
      return entries.get(key)?.value;
    },
    set(key, value) {
      purge();
      entries.delete(key);
      while (entries.size >= max) entries.delete(entries.keys().next().value as string);
      entries.set(key, { value, expiresAt: now() + ttl });
    },
    delete(key) {
      entries.delete(key);
    },
    get size() {
      purge();
      return entries.size;
    },
  };
}

/** Memo key for a download token: the hash only, never the token itself. */
export const memoKeyForToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export interface MediaDownloaderDeps {
  studio: Pick<StudioOps, "getMedia">;
  vault: ClientVault;
  throttle: Pick<Throttle, "schedule">;
  fetch: FetchLike;
  audit: AuditSink;
  now?: () => number;
  /** Optional memo of the fresh media target (production wiring passes one). Without it every request re-lists. */
  urlMemo?: UrlMemo<{ url: string; kind: MediaKind }>;
}

/** Only a single byte range is forwarded; anything else is ignored (the whole file is served), as RFC 9110 allows. */
export const RANGE_RE = /^bytes=(\d+-\d*|-\d+)$/;
export const sanitizeRange = (h: string | null): string | undefined => (h !== null && RANGE_RE.test(h.trim()) ? h.trim() : undefined);

const sameJar = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function outcomeOf(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e && typeof (e as { kind: unknown }).kind === "string") return `error:${(e as { kind: string }).kind}`;
  if (isVaultError(e)) return `error:vault_${e.code}`;
  return "error:internal";
}

export function createMediaDownloader(deps: MediaDownloaderDeps) {
  const now = deps.now ?? Date.now;

  async function open(claims: MediaClaims, opts: { range?: string; signal?: AbortSignal; memoKey?: string } = {}): Promise<OpenedMedia> {
    let outcome = "ok";
    try {
      // Fresh URL every time. This read also refreshes the stored cookie jar if Google rotated it, so load the jar after it.
      // A memo hit skips only the notebook re-list; the account is still checked below (getJar fails for a disabled account).
      let target = opts.memoKey ? deps.urlMemo?.get(opts.memoKey) : undefined;
      if (!target) {
        const fresh = await deps.studio.getMedia(claims.accountId, claims.notebookId, claims.artifactId, "media_download");
        target = { url: fresh.url, kind: fresh.kind };
        if (target.kind !== claims.kind) throw new ArtifactNotFoundError();
        if (opts.memoKey) deps.urlMemo?.set(opts.memoKey, target);
      }
      const jar = await deps.vault.getJar(claims.accountId);
      const m = await deps.throttle.schedule(claims.accountId, () =>
        fetchMedia(deps.fetch, jar, target.url, { range: opts.range, signal: opts.signal, now }),
      );
      if (!sameJar(jar, m.jar)) await deps.vault.updateJar(claims.accountId, m.jar).catch(() => undefined);
      return { status: m.status, body: m.body, kind: target.kind, contentLength: m.contentLength, contentRange: m.contentRange, acceptRanges: m.acceptRanges };
    } catch (e) {
      outcome = outcomeOf(e);
      if (opts.memoKey) deps.urlMemo?.delete(opts.memoKey); // a failure may mean the URL went stale: next request re-lists
      throw e;
    } finally {
      await deps.audit.write({ accountId: claims.accountId, tool: "media_download", rpcId: "media", outcome, at: new Date(now()) }).catch(() => undefined);
    }
  }

  return { open };
}

export type MediaDownloader = ReturnType<typeof createMediaDownloader>;

export interface MediaRouteDeps {
  /** Lazy: throws when OAUTH_SIGNING_KEY is missing (answered as 503). */
  key: () => Buffer;
  /** Lazy: throws when storage is not configured (answered as 503). */
  downloader: () => MediaDownloader;
  now?: () => number;
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const generic = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });

/** Anything that must look the same to a caller who has no valid link. */
const notFound = () => generic(404, "Not found");

export async function handleMediaRequest(request: Request, token: string, d: MediaRouteDeps): Promise<Response> {
  if (request.method !== "GET") return generic(405, "Method not allowed", { Allow: "GET" });
  const now = d.now ?? Date.now;
  let claims: MediaClaims | null;
  let downloader: MediaDownloader;
  try {
    claims = verifyMediaToken(d.key(), token, now);
    if (!claims) return notFound();
    downloader = d.downloader();
  } catch {
    return generic(503, "Service unavailable");
  }

  let m: OpenedMedia;
  try {
    m = await downloader.open(claims, { range: sanitizeRange(request.headers.get("range")), signal: request.signal, memoKey: memoKeyForToken(token) });
  } catch (e) {
    if (isVaultError(e)) return notFound(); // disabled, wiped or unknown account
    if (e instanceof ArtifactNotFoundError || e instanceof ArtifactNotReadyError || e instanceof ArtifactNotDownloadableError) return notFound();
    if (e instanceof RangeNotSatisfiableError) {
      return generic(416, "Requested range not satisfiable", e.contentRange ? { "Content-Range": e.contentRange } : {});
    }
    if (e instanceof CooldownActiveError) return generic(503, "Please try again shortly", { "Retry-After": String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) });
    if (e instanceof DailyCapReachedError) return generic(503, "Please try again later");
    // Expired Google auth (HTML / empty / non-2xx), network, disallowed redirect, RPC trouble: one generic answer.
    console.error("media download failed:", outcomeOf(e)); // a classification only, never a message
    return generic(502, "The file could not be fetched right now. Ask Claude for a new link.");
  }

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": MEDIA_CONTENT_TYPE[m.kind],
    "Content-Disposition": `inline; filename="${MEDIA_FILENAME[m.kind]}"`,
    "Accept-Ranges": m.acceptRanges ?? (m.status === 206 ? "bytes" : "none"),
  };
  if (m.contentLength !== null) headers["Content-Length"] = String(m.contentLength);
  if (m.status === 206 && m.contentRange) headers["Content-Range"] = m.contentRange;
  return new Response(m.body, { status: m.status, headers });
}
