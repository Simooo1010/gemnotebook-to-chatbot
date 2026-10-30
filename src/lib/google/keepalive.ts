import type { CookieJar } from "@/lib/vault/jar";
import type { AccountRepo } from "@/lib/vault/storage";
import { RotateAuthError } from "./errors";
import { fetchWithJar, type FetchLike } from "./http";

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

/** POST RotateCookies (PROTOCOL §1.3). Returns the merged jar; rotated=false when rate-limited. */
export async function rotateCookies(i: RotateInput): Promise<{ jar: CookieJar; rotated: boolean }> {
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
  if (response.status === 401 || response.status === 403) throw new RotateAuthError(response.status);
  if (/\/(ServiceLogin|signin)/i.test(new URL(finalUrl).pathname)) throw new RotateAuthError(response.status);
  return { jar, rotated: response.status >= 200 && response.status < 300 };
}

export interface KeepAliveVault {
  getJar(accountId: string): Promise<CookieJar>;
  updateJar(accountId: string, jar: CookieJar): Promise<void>;
}

export type KeepAliveOutcome = "rotated" | "skipped" | "needs_reauth" | "error";

/** Load → rotate → persist. On auth failure the account is marked needs_reauth, never retried. */
export async function keepAliveAccount(
  vault: KeepAliveVault,
  accountId: string,
  deps: {
    fetch: FetchLike;
    accounts: Pick<AccountRepo, "setStatus">;
    limiter: RotationLimiter;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<KeepAliveOutcome> {
  const jar = await vault.getJar(accountId);
  try {
    const r = await rotateCookies({ fetch: deps.fetch, jar, accountId, limiter: deps.limiter, now: deps.now, timeoutMs: deps.timeoutMs });
    if (JSON.stringify(r.jar) !== JSON.stringify(jar)) await vault.updateJar(accountId, r.jar);
    return r.rotated ? "rotated" : "skipped";
  } catch (e) {
    if (e instanceof RotateAuthError) {
      await deps.accounts.setStatus(accountId, "needs_reauth");
      return "needs_reauth";
    }
    return "error";
  }
}
