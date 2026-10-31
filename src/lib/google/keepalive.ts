import type { CookieJar } from "@/lib/vault/jar";
import type { AccountRepo } from "@/lib/vault/storage";
import { CookieMismatchError, RotateAuthError, SignedOutError } from "./errors";
import { fetchWithJar, type FetchLike } from "./http";
import { fetchPageTokens } from "./session";

export const ROTATE_URL = "https://accounts.google.com/RotateCookies";
export const ROTATE_BODY = '[000,"-0000000000000000000"]';
export const ROTATE_MIN_INTERVAL_MS = 60_000;
export const ROTATE_TIMEOUT_MS = 15_000;

/** Remembers the last rotation per account (at most once per 60 s). In-memory per instance. */
export function createRotationLimiter(opts: { now?: () => number; minIntervalMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const min = opts.minIntervalMs ?? ROTATE_MIN_INTERVAL_MS;
  const last = new Map<string, number>();
  return {
    allow(accountId: string): boolean {
      const l = last.get(accountId);
      return l === undefined || now() - l >= min;
    },
    mark(accountId: string): void {
      last.set(accountId, now());
    },
  };
}
export type RotationLimiter = ReturnType<typeof createRotationLimiter>;

export interface RotateInput {
  fetch: FetchLike;
  jar: CookieJar;
  accountId: string;
  limiter: RotationLimiter;
  now?: () => number;
  timeoutMs?: number;
}

/** True only for a sign-in page on accounts.google.com (ServiceLogin / signin paths). */
export function isSignInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "accounts.google.com" && /\/(ServiceLogin|signin)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * POST RotateCookies (PROTOCOL §1.3). Returns the merged jar; rotated=false when rate-limited or not 2xx (status says why).
 * Throws RotateAuthError on 401/403 (signInRedirect=false: not proof of sign-out) or on a sign-in redirect (signInRedirect=true).
 */
export async function rotateCookies(i: RotateInput): Promise<{ jar: CookieJar; rotated: boolean; status?: number }> {
  if (!i.limiter.allow(i.accountId)) return { jar: i.jar, rotated: false };
  i.limiter.mark(i.accountId);
  const { response, jar, finalUrl } = await fetchWithJar(
    i.fetch,
    i.jar,
    ROTATE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://accounts.google.com" },
      body: ROTATE_BODY,
      signal: AbortSignal.timeout(i.timeoutMs ?? ROTATE_TIMEOUT_MS),
    },
    { now: i.now },
  );
  await response.body?.cancel().catch(() => undefined);
  if (isSignInUrl(finalUrl)) throw new RotateAuthError(response.status, true);
  if (response.status === 401 || response.status === 403) throw new RotateAuthError(response.status, false);
  return { jar, rotated: response.status >= 200 && response.status < 300, status: response.status };
}

export interface KeepAliveVault {
  getJar(accountId: string): Promise<CookieJar>;
  updateJar(accountId: string, jar: CookieJar): Promise<void>;
}

export type KeepAliveOutcome = "rotated" | "skipped" | "needs_reauth" | "error";

/**
 * Load → rotate → persist. needs_reauth is set ONLY on positive evidence of a signed-out session: a sign-in redirect
 * from RotateCookies, or (after a 401/403) a confirming homepage read that classifies signed_out / cookie_mismatch.
 * Region gate, network errors, 5xx and an unconfirmed 401/403 → "error"; the account stays active. Never retried.
 */
export async function keepAliveAccount(
  vault: KeepAliveVault,
  accountId: string,
  deps: {
    fetch: FetchLike;
    accounts: Pick<AccountRepo, "setStatus">;
    limiter: RotationLimiter;
    now?: () => number;
    timeoutMs?: number;
    /** NotebookLM origin for the confirming probe. Without it an unconfirmed 401/403 is reported as "error". */
    probe?: { base: string; authuser?: string | number };
  },
): Promise<KeepAliveOutcome> {
  const jar = await vault.getJar(accountId);
  const flag = async (): Promise<KeepAliveOutcome> => {
    await deps.accounts.setStatus(accountId, "needs_reauth");
    return "needs_reauth";
  };
  try {
    const r = await rotateCookies({ fetch: deps.fetch, jar, accountId, limiter: deps.limiter, now: deps.now, timeoutMs: deps.timeoutMs });
    if (JSON.stringify(r.jar) !== JSON.stringify(jar)) await vault.updateJar(accountId, r.jar);
    if (r.rotated) return "rotated";
    return r.status === undefined ? "skipped" : "error";
  } catch (e) {
    if (!(e instanceof RotateAuthError)) return "error";
    if (e.signInRedirect) return flag();
    if (!deps.probe) return "error";
    try {
      await fetchPageTokens({
        fetch: deps.fetch,
        jar,
        base: deps.probe.base,
        authuser: deps.probe.authuser,
        now: deps.now,
        signal: AbortSignal.timeout(deps.timeoutMs ?? ROTATE_TIMEOUT_MS),
      });
      return "error"; // session is alive; the 401/403 came from elsewhere
    } catch (pe) {
      if (pe instanceof SignedOutError || pe instanceof CookieMismatchError) return flag();
      return "error"; // region gate, unknown page, network: never flag
    }
  }
}
