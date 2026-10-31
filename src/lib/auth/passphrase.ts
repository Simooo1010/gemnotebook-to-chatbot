// Owner passphrase check and login attempt limiter. Pure except for node:crypto.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEYLEN = 32;
const MAX_INPUT = 1024;

/** Returns `scrypt$N$r$p$saltB64$hashB64`. */
export function hashPassphrase(passphrase: string, opts: { N?: number; r?: number; p?: number } = {}): string {
  const N = opts.N ?? DEFAULT_N;
  const r = opts.r ?? DEFAULT_R;
  const p = opts.p ?? DEFAULT_P;
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyScrypt(input: string, stored: string): boolean {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltB64 = "", hashB64 = ""] = parts;
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || (N & (N - 1)) !== 0 || N > 2 ** 20 || r > 32 || p > 16) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const got = scryptSync(input, salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

const processKey = randomBytes(32);
const mac = (s: string) => createHmac("sha256", processKey).update(s, "utf8").digest();

/** Fail-closed owner check. Never logs or echoes the input or stored values. */
export function verifyOwnerPassphrase(input: unknown, env: Record<string, string | undefined>): boolean {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT) return false;
  const hash = env.OWNER_PASSPHRASE_HASH?.trim();
  if (hash) return verifyScrypt(input, hash);
  const plain = env.OWNER_PASSPHRASE;
  if (plain) return timingSafeEqual(mac(input), mac(plain));
  return false;
}

export interface LimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  now?: () => number;
}

export interface LimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  /** True when the attempt was refused because the limiter's storage is missing or failing (not because of a real limit). */
  unavailable?: boolean;
}

/** In-memory: N failures within the window per key → locked out for lockoutMs. */
export function createLoginLimiter(opts: LimiterOptions = {}) {
  const max = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const state = new Map<string, { failures: number[]; lockedUntil: number }>();

  const get = (k: string) => {
    let s = state.get(k);
    if (!s) state.set(k, (s = { failures: [], lockedUntil: 0 }));
    s.failures = s.failures.filter((t) => now() - t < windowMs);
    return s;
  };

  return {
    /**
     * Register an attempt BEFORE the passphrase is verified (so a burst of parallel guesses is still counted) and decide.
     * Counted as a failure; `recordSuccess` clears it. Same lock-out outcome as check + recordFailure.
     */
    attempt(k: string): LimitDecision {
      const d = this.check(k);
      if (!d.allowed) return d;
      this.recordFailure(k);
      return { allowed: true, retryAfterMs: 0 };
    },
    check(k: string): LimitDecision {
      const s = get(k);
      const left = s.lockedUntil - now();
      return left > 0 ? { allowed: false, retryAfterMs: left } : { allowed: true, retryAfterMs: 0 };
    },
    recordFailure(k: string): LimitDecision {
      const s = get(k);
      s.failures.push(now());
      if (s.failures.length >= max) {
        s.lockedUntil = now() + lockoutMs;
        s.failures = [];
      }
      return this.check(k);
    },
    recordSuccess(k: string): void {
      state.delete(k);
    },
  };
}
