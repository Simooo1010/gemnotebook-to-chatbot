// Persistent owner-login limiter (Supabase `login_attempts`), shared by every serverless instance.
// Insert-first: each attempt is recorded BEFORE the passphrase is checked, then the attempts inside the window are counted.
// A burst of parallel guesses therefore cannot all slip through (the k-th row to commit sees at least k rows), unlike
// read-modify-write counters. Denied attempts remove their own row, so an attacker hammering a locked key cannot extend the lock.
// Sliding window: more than `maxAttempts` rows in `windowMs` => denied until enough old rows age out.
// Keys are SHA-256 hashes of the client IP (see clientKey). Fails CLOSED: any store error denies the attempt.
import type { LimitDecision } from "./passphrase";
import { createLoginLimiter } from "./passphrase";
import { createServiceDb, type Db, type Row } from "@/lib/vault/supabase";

export const LOGIN_ATTEMPTS_TABLE = "login_attempts";
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_WINDOW_MS = 15 * 60_000;
export const PRUNE_AFTER_MS = 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const STORE_ERROR_RETRY_MS = 60_000;
const MAX_ROWS_READ = 100;

export interface LoginLimiter {
  /** Register an attempt and decide whether it may proceed. */
  attempt(key: string): LimitDecision | Promise<LimitDecision>;
  /** Forget the key's attempts after a successful login. Best-effort. */
  recordSuccess(key: string): void | Promise<void>;
}

const DENY: LimitDecision = { allowed: false, retryAfterMs: STORE_ERROR_RETRY_MS, unavailable: true };

/** Always denies. Used in production when no store is configured (fail closed). */
export function createDenyLimiter(): LoginLimiter {
  return { attempt: () => DENY, recordSuccess: () => undefined };
}

export interface PersistentLimiterOptions {
  db: Db;
  maxAttempts?: number;
  windowMs?: number;
  now?: () => number;
}

export function createPersistentLoginLimiter(o: PersistentLimiterOptions): LoginLimiter {
  const max = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = o.windowMs ?? DEFAULT_WINDOW_MS;
  const now = o.now ?? Date.now;
  let lastPrune = 0;

  async function prune(key: string, t: number): Promise<void> {
    if (!o.db.deleteBefore) return;
    // Own key: rows outside the window no longer count. Global: everything older than 24 h, at most once an hour per instance.
    await o.db.deleteBefore(LOGIN_ATTEMPTS_TABLE, "attempted_at", new Date(t - windowMs).toISOString(), { key_hash: key });
    if (t - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = t;
      await o.db.deleteBefore(LOGIN_ATTEMPTS_TABLE, "attempted_at", new Date(t - PRUNE_AFTER_MS).toISOString());
    }
  }

  return {
    async attempt(key: string): Promise<LimitDecision> {
      const t = now();
      try {
        const own: Row = await o.db.insert(LOGIN_ATTEMPTS_TABLE, { key_hash: key, attempted_at: new Date(t).toISOString() });
        const rows = await o.db.select(LOGIN_ATTEMPTS_TABLE, { match: { key_hash: key }, orderBy: ["attempted_at"], from: 0, to: MAX_ROWS_READ - 1 });
        const times = rows
          .filter((r) => r.id !== own.id)
          .map((r) => Date.parse(String(r.attempted_at)))
          .filter((ms) => Number.isFinite(ms) && t - ms < windowMs)
          .sort((a, b) => a - b);
        if (times.length < max) {
          // Housekeeping must never turn an allowed attempt into a failure.
          await prune(key, t).catch(() => undefined);
          return { allowed: true, retryAfterMs: 0 };
        }
        // Denied: do not let the denied attempt itself extend the lock.
        await o.db.delete(LOGIN_ATTEMPTS_TABLE, { id: own.id as string });
        // Allowed again once (times.length - max + 1) of the oldest rows have aged out.
        const unlockAt = times[times.length - max]! + windowMs;
        return { allowed: false, retryAfterMs: Math.max(1000, unlockAt - t) };
      } catch {
        // Fail closed. A row we could not remove only makes the lock stricter.
        return DENY;
      }
    },
    async recordSuccess(key: string): Promise<void> {
      try {
        await o.db.delete(LOGIN_ATTEMPTS_TABLE, { key_hash: key });
      } catch {
        // Best effort: stale rows only expire on their own.
      }
    },
  };
}

type Env = Record<string, string | undefined>;
const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Supabase when configured; in-memory only outside production; otherwise (or on any config problem) deny everything. */
export function createLoginLimiterFromEnv(env: Env): LoginLimiter {
  try {
    if (has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY)) {
      return createPersistentLoginLimiter({ db: createServiceDb(env) });
    }
  } catch {
    return createDenyLimiter();
  }
  return env.NODE_ENV === "production" ? createDenyLimiter() : createLoginLimiter();
}

const g = globalThis as unknown as { __loginLimiter?: LoginLimiter };

/** Process-wide limiter (the in-memory dev fallback must survive hot reloads). */
export function getLoginLimiter(): LoginLimiter {
  return (g.__loginLimiter ??= createLoginLimiterFromEnv(process.env));
}
