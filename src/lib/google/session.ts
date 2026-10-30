import { classifyHomepage, extractPageTokens } from "@/lib/rpc/page";
import type { CookieJar } from "@/lib/vault/jar";
import {
  CookieMismatchError,
  RegionGateError,
  SignedOutError,
  UnknownHomepageError,
} from "./errors";
import { browserHeaders, fetchWithJar, type FetchLike } from "./http";

export interface SessionTokens {
  at: string;
  fsid: string;
  bl: string | null;
}

export interface FetchPageTokensInput {
  fetch: FetchLike;
  jar: CookieJar;
  base: string;
  authuser?: string | number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PageTokensOk {
  status: "ok";
  tokens: SessionTokens;
  jar: CookieJar;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

/** GET {base}/?hl=en and extract SNlM0e/FdrFJe/cfb2h. Failures throw typed errors carrying only the final host. */
export async function fetchPageTokens(i: FetchPageTokensInput): Promise<PageTokensOk> {
  const u = new URL(`${i.base.replace(/\/+$/, "")}/`);
  u.searchParams.set("hl", "en");
  if (i.authuser !== undefined && i.authuser !== "") u.searchParams.set("authuser", String(i.authuser));
  const { response, finalUrl, jar } = await fetchWithJar(
    i.fetch,
    i.jar,
    u.toString(),
    { method: "GET", headers: browserHeaders("document"), signal: i.signal },
    { now: i.now },
  );
  const html = await response.text();
  const host = hostOf(finalUrl);
  const state = classifyHomepage({ finalUrl, status: response.status, html });
  switch (state) {
    case "signed_out":
      throw new SignedOutError(host);
    case "region_gate":
      throw new RegionGateError(host);
    case "cookie_mismatch":
      throw new CookieMismatchError(host);
    case "unknown":
      throw new UnknownHomepageError(host, `HTTP ${response.status}`);
  }
  const t = extractPageTokens(html);
  if (!t.at) throw new SignedOutError(host);
  if (!t.fsid) throw new UnknownHomepageError(host, "missing FdrFJe");
  return { status: "ok", tokens: { at: t.at, fsid: t.fsid, bl: t.bl || null }, jar };
}

/** Per-account in-memory token cache with TTL. */
export function createTokenCache(opts: { now?: () => number; ttlMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const m = new Map<string, { tokens: SessionTokens; at: number }>();
  return {
    get(accountId: string): SessionTokens | null {
      const e = m.get(accountId);
      if (!e) return null;
      if (now() - e.at >= ttl) {
        m.delete(accountId);
        return null;
      }
      return e.tokens;
    },
    set(accountId: string, tokens: SessionTokens): void {
      m.set(accountId, { tokens, at: now() });
    },
    invalidate(accountId: string): void {
      m.delete(accountId);
    },
  };
}
export type TokenCache = ReturnType<typeof createTokenCache>;
