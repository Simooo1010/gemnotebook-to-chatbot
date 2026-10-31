// Synthetic data only. The store is an in-memory fake of the Db port.
import { describe, expect, it } from "vitest";
import { VaultStorageError, type Db, type Row } from "@/lib/vault/supabase";
import { createDenyLimiter, createLoginLimiterFromEnv, createPersistentLoginLimiter, LOGIN_ATTEMPTS_TABLE } from "./login-limiter";

const K = "a".repeat(64);
const K2 = "b".repeat(64);

function fakeDb(opts: { slowInsert?: boolean } = {}) {
  const rows: Row[] = [];
  const state = { fail: false, n: 0, deleteBeforeCalls: [] as string[] };
  const boom = () => {
    if (state.fail) throw new VaultStorageError();
  };
  const db: Db = {
    async insert(t, row) {
      expect(t).toBe(LOGIN_ATTEMPTS_TABLE);
      boom();
      if (opts.slowInsert) await Promise.resolve();
      const r = { id: ++state.n, ...row };
      rows.push(r);
      return { ...r };
    },
    async select(_t, o) {
      boom();
      return rows
        .filter((r) => Object.entries(o.match ?? {}).every(([k, v]) => r[k] === v))
        .sort((a, b) => String(a.attempted_at).localeCompare(String(b.attempted_at)))
        .slice(o.from, o.to + 1)
        .map((r) => ({ ...r }));
    },
    async update() {
      return 0;
    },
    async upsert() {},
    async delete(_t, m) {
      boom();
      for (let i = rows.length - 1; i >= 0; i--) if (Object.entries(m).every(([k, v]) => rows[i]![k] === v)) rows.splice(i, 1);
    },
    async deleteBefore(_t, col, iso, m = {}) {
      boom();
      state.deleteBeforeCalls.push(`${col}:${iso}:${JSON.stringify(m)}`);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i]![col]) < iso && Object.entries(m).every(([k, v]) => rows[i]![k] === v)) rows.splice(i, 1);
      }
    },
  };
  return { db, rows, state };
}

describe("persistent login limiter", () => {
  it("allows maxAttempts attempts per key, then denies with a Retry-After, per key", async () => {
    let t = 1_700_000_000_000;
    const { db } = fakeDb();
    const l = createPersistentLoginLimiter({ db, now: () => t });
    for (let i = 0; i < 5; i++) {
      expect((await l.attempt(K)).allowed).toBe(true);
      t += 1000;
    }
    const d = await l.attempt(K);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(d.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
    expect((await l.attempt(K2)).allowed).toBe(true);
  });

  it("is shared state: a second limiter instance on the same store sees the first one's attempts", async () => {
    const { db } = fakeDb();
    const a = createPersistentLoginLimiter({ db, maxAttempts: 2 });
    const b = createPersistentLoginLimiter({ db, maxAttempts: 2 });
    expect((await a.attempt(K)).allowed).toBe(true);
    expect((await b.attempt(K)).allowed).toBe(true);
    expect((await a.attempt(K)).allowed).toBe(false);
  });

  it("denied attempts do not extend the lock, and it opens again as old attempts age out", async () => {
    let t = 1_700_000_000_000;
    const { db, rows } = fakeDb();
    const l = createPersistentLoginLimiter({ db, now: () => t, maxAttempts: 2, windowMs: 10 * 60_000 });
    await l.attempt(K); // t0
    t += 60_000;
    await l.attempt(K); // t0+1m
    for (let i = 0; i < 20; i++) {
      t += 1000;
      expect((await l.attempt(K)).allowed).toBe(false); // hammering
    }
    expect(rows.filter((r) => r.key_hash === K)).toHaveLength(2); // denied rows removed
    t = 1_700_000_000_000 + 10 * 60_000 + 1000; // first attempt aged out
    expect((await l.attempt(K)).allowed).toBe(true);
  });

  it("a parallel burst cannot exceed maxAttempts (insert-first counting)", async () => {
    const { db } = fakeDb({ slowInsert: true });
    const l = createPersistentLoginLimiter({ db, maxAttempts: 5 });
    const results = await Promise.all(Array.from({ length: 40 }, () => l.attempt(K)));
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(5);
    // Conservative by design: in the worst interleaving every parallel attempt sees the others and is denied (and removes its row).
    expect((await l.attempt(K)).allowed).toBe(true); // the burst left no stale rows behind
  });

  it("recordSuccess clears the key only", async () => {
    const { db, rows } = fakeDb();
    const l = createPersistentLoginLimiter({ db, maxAttempts: 1 });
    await l.attempt(K);
    await l.attempt(K2);
    await l.recordSuccess(K);
    expect(rows.map((r) => r.key_hash)).toEqual([K2]);
    expect((await l.attempt(K)).allowed).toBe(true);
  });

  it("fails closed on any store error, and stores only the hash key and a timestamp", async () => {
    const f = fakeDb();
    const l = createPersistentLoginLimiter({ db: f.db });
    f.state.fail = true;
    const d = await l.attempt(K);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    f.state.fail = false;
    await l.attempt(K);
    expect(Object.keys(f.rows[0]!).sort()).toEqual(["attempted_at", "id", "key_hash"]);
    f.state.fail = true;
    await expect(l.recordSuccess(K)).resolves.toBeUndefined(); // best effort, never throws
  });

  it("prunes: own key outside the window on every allowed attempt, everything older than 24 h at most hourly", async () => {
    let t = 1_700_000_000_000;
    const f = fakeDb();
    // An old row of another key (25 h old) and a stale row of ours (20 min old).
    f.rows.push({ id: 900, key_hash: K2, attempted_at: new Date(t - 25 * 3600_000).toISOString() });
    f.rows.push({ id: 901, key_hash: K, attempted_at: new Date(t - 20 * 60_000).toISOString() });
    const l = createPersistentLoginLimiter({ db: f.db, now: () => t });
    expect((await l.attempt(K)).allowed).toBe(true);
    expect(f.rows.find((r) => r.id === 900)).toBeUndefined();
    expect(f.rows.find((r) => r.id === 901)).toBeUndefined();
    const calls = f.state.deleteBeforeCalls.length;
    t += 60_000;
    await l.attempt(K);
    expect(f.state.deleteBeforeCalls.length).toBe(calls + 1); // only the own-key prune this time
  });

  it("a failing prune does not turn an allowed attempt into a denial", async () => {
    const f = fakeDb();
    f.db.deleteBefore = async () => {
      throw new VaultStorageError();
    };
    const l = createPersistentLoginLimiter({ db: f.db });
    expect((await l.attempt(K)).allowed).toBe(true);
  });
});

describe("createLoginLimiterFromEnv", () => {
  it("production without storage (or with broken storage config) denies everything", async () => {
    expect((await createLoginLimiterFromEnv({ NODE_ENV: "production" }).attempt(K)).allowed).toBe(false);
    expect((await createLoginLimiterFromEnv({ NODE_ENV: "production", SUPABASE_URL: "https://x.supabase.co" }).attempt(K)).allowed).toBe(false);
    expect((await createDenyLimiter().attempt(K)).allowed).toBe(false);
  });

  it("outside production without storage falls back to the in-memory limiter", async () => {
    const l = createLoginLimiterFromEnv({ NODE_ENV: "development" });
    for (let i = 0; i < 5; i++) expect((await l.attempt(K)).allowed).toBe(true);
    expect((await l.attempt(K)).allowed).toBe(false);
    await l.recordSuccess(K);
    expect((await l.attempt(K)).allowed).toBe(true);
  });

  it("builds a Supabase-backed limiter when configured (no call at construction)", () => {
    const l = createLoginLimiterFromEnv({ NODE_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" });
    expect(typeof l.attempt).toBe("function");
  });
});
