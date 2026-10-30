import { CooldownActiveError, DailyCapReachedError } from "./errors";

/** Per-account pacing (SPEC §4): one request at a time, 1.5–4 s random gap, daily caps, backoff after quota/429. */

export type UsageKind = "audio" | "video" | "chat";

export interface UsageCounter {
  get(accountId: string, day: string, kind: UsageKind): Promise<number>;
  increment(accountId: string, day: string, kind: UsageKind): Promise<number>;
}

export const DEFAULT_DAILY_CAPS: Readonly<Record<UsageKind, number>> = { audio: 2, video: 2, chat: 30 };
export const MIN_GAP_MS = 1500;
export const MAX_GAP_MS = 4000;
export const POLL_FLOOR_MS = 15_000;

/** Polling helper: never tighter than 15 s. */
export function pollDelayMs(requestedMs?: number): number {
  return Math.max(POLL_FLOOR_MS, requestedMs ?? POLL_FLOOR_MS);
}

/** UTC calendar day "YYYY-MM-DD" used as the usage-counter key. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface ThrottleDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0,1). */
  random?: () => number;
  usage?: UsageCounter;
  caps?: Partial<Record<UsageKind, number>>;
  gapMinMs?: number;
  gapMaxMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

interface AccountState {
  tail: Promise<unknown>;
  lastEnd: number | null;
  cooldownUntil: number;
  strikes: number;
}

export function createThrottle(deps: ThrottleDeps = {}) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const caps = { ...DEFAULT_DAILY_CAPS, ...(deps.caps ?? {}) };
  const gapMin = deps.gapMinMs ?? MIN_GAP_MS;
  const gapMax = deps.gapMaxMs ?? MAX_GAP_MS;
  const baseMs = deps.backoffBaseMs ?? 30_000;
  const maxMs = deps.backoffMaxMs ?? 15 * 60_000;
  const states = new Map<string, AccountState>();

  const state = (id: string): AccountState => {
    let s = states.get(id);
    if (!s) {
      s = { tail: Promise.resolve(), lastEnd: null, cooldownUntil: 0, strikes: 0 };
      states.set(id, s);
    }
    return s;
  };

  function gapMs(): number {
    return gapMin + Math.floor(random() * (gapMax - gapMin));
  }

  function assertNoCooldown(id: string, s: AccountState): void {
    const left = s.cooldownUntil - now();
    if (left > 0) throw new CooldownActiveError(id, left);
  }

  async function run<T>(id: string, fn: () => Promise<T>, usageKind?: UsageKind): Promise<T> {
    const s = state(id);
    assertNoCooldown(id, s);
    if (usageKind && deps.usage) {
      const day = utcDay(now());
      const used = await deps.usage.get(id, day, usageKind);
      if (used >= caps[usageKind]) throw new DailyCapReachedError(id, usageKind, caps[usageKind]);
    }
    if (s.lastEnd !== null) {
      const wait = gapMs() - (now() - s.lastEnd);
      if (wait > 0) await sleep(wait);
      assertNoCooldown(id, s);
    }
    try {
      // Counted when the request is sent (conservative: an ambiguous attempt still counts).
      if (usageKind && deps.usage) await deps.usage.increment(id, utcDay(now()), usageKind);
      return await fn();
    } finally {
      s.lastEnd = now();
    }
  }

  return {
    /** Runs fn after every earlier task for this account settled. Never retries. */
    schedule<T>(accountId: string, fn: () => Promise<T>, opts: { usageKind?: UsageKind } = {}): Promise<T> {
      const s = state(accountId);
      const p = s.tail.then(() => run(accountId, fn, opts.usageKind));
      s.tail = p.catch(() => undefined);
      return p;
    },
    /** Record a quota/429 response: exponential cooldown, at least Retry-After, capped. */
    noteQuota(accountId: string, retryAfterSec?: number): number {
      const s = state(accountId);
      const exp = Math.min(maxMs, baseMs * 2 ** s.strikes);
      const ra = retryAfterSec !== undefined ? retryAfterSec * 1000 : 0;
      const ms = Math.min(maxMs, Math.max(exp, ra));
      s.strikes += 1;
      s.cooldownUntil = now() + ms;
      return ms;
    },
    noteSuccess(accountId: string): void {
      state(accountId).strikes = 0;
    },
    cooldownRemainingMs(accountId: string): number {
      return Math.max(0, state(accountId).cooldownUntil - now());
    },
    caps: caps as Readonly<Record<UsageKind, number>>,
  };
}

export type Throttle = ReturnType<typeof createThrottle>;

/** In-memory UsageCounter for tests/dev. */
export class MemoryUsageCounter implements UsageCounter {
  private m = new Map<string, number>();
  async get(a: string, d: string, k: UsageKind) {
    return this.m.get(`${a}|${d}|${k}`) ?? 0;
  }
  async increment(a: string, d: string, k: UsageKind) {
    const key = `${a}|${d}|${k}`;
    const n = (this.m.get(key) ?? 0) + 1;
    this.m.set(key, n);
    return n;
  }
}
