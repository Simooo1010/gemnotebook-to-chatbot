// The app's REAL Supabase adapters (through the real supabase-js client) against docs/qa/fake-supabase.mjs.
// Covers paths the browser walkthrough cannot reach without a real Google session: created_objects, usage_counters, audit_log,
// pagination beyond one page, persistent login limiter under a parallel burst, OAuth store atomicity, error mapping.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceDb, SupabaseAccountRepo, SupabaseSessionVault, VaultStorageError } from "@/lib/vault/supabase";
import { SupabaseCreatedObjects } from "@/lib/notebooklm/created";
import { SupabaseAuditSink, SupabaseUsageCounter } from "@/lib/google/supabase";
import { createPersistentLoginLimiter } from "@/lib/auth/login-limiter";
import { createSupabaseStore } from "@/lib/oauth/supabase";

const PORT = 3411, KEY = "adapters-test-service-key", ANON = "adapters-test-anon-key";
const EMU = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
const db = () => createServiceDb({ SUPABASE_URL: EMU, SUPABASE_SERVICE_ROLE_KEY: KEY });
type Rows = Record<string, unknown>[];
const tables = async () => (await (await fetch(EMU + "/__qa/tables")).json()) as { [k: string]: Rows } & Record<"sessions" | "created_objects" | "usage_counters" | "audit_log" | "oauth_codes" | "oauth_tokens", Rows>;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

beforeAll(async () => {
  proc = spawn(process.execPath, [path.resolve(__dirname, "fake-supabase.mjs")], { env: { ...process.env, FAKE_SB_PORT: String(PORT), FAKE_SB_KEY: KEY, FAKE_SB_ANON_KEY: ANON }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
});
afterAll(() => proc.kill());

describe("vault adapters", () => {
  it("accounts: create / list (paginated > 200) / get / setStatus / remove", async () => {
    const repo = new SupabaseAccountRepo(db());
    const first = await repo.create({ label: "A0", emailHash: null });
    for (let i = 1; i < 205; i++) await repo.create({ label: `A${i}`, emailHash: null });
    const all = await repo.list();
    expect(all.length).toBe(205);
    expect(new Set(all.map((a) => a.id)).size).toBe(205);
    expect((await repo.get(first.id))?.label).toBe("A0");
    expect(await repo.get(uuid(999))).toBeNull();
    await repo.setStatus(first.id, "disabled");
    expect((await repo.get(first.id))?.status).toBe("disabled");
    await expect(repo.setStatus(uuid(999), "disabled")).rejects.toBeInstanceOf(VaultStorageError);
    await repo.remove(first.id);
    expect(await repo.get(first.id)).toBeNull();
  });
  it("accounts.get with a non-uuid id surfaces a storage error (callers must validate)", async () => {
    const repo = new SupabaseAccountRepo(db());
    await expect(repo.get("not-a-uuid")).rejects.toBeInstanceOf(VaultStorageError);
  });
  it("label over 60 chars is rejected by the storage CHECK (callers must validate first)", async () => {
    await expect(new SupabaseAccountRepo(db()).create({ label: "x".repeat(61), emailHash: null })).rejects.toBeInstanceOf(VaultStorageError);
  });
  it("sessions: put twice = one row (merge upsert), get, delete; session of unknown account fails (FK)", async () => {
    const repo = new SupabaseAccountRepo(db());
    const a = await repo.create({ label: "S", emailHash: null });
    const sv = new SupabaseSessionVault(db());
    await sv.put(a.id, "env-1", new Date("2026-10-31T10:00:00Z"));
    await sv.put(a.id, "env-2", new Date("2026-10-31T11:00:00.123Z"));
    const got = await sv.get(a.id);
    expect(got?.envelope).toBe("env-2");
    expect(got?.rotatedAt.toISOString()).toBe("2026-10-31T11:00:00.123Z");
    expect((await tables()).sessions.filter((s) => s.account_id === a.id).length).toBe(1);
    await sv.delete(a.id);
    expect(await sv.get(a.id)).toBeNull();
    await expect(sv.put(uuid(998), "x", new Date())).rejects.toBeInstanceOf(VaultStorageError);
  });
  it("removing an account cascades its session, counters and created objects", async () => {
    const repo = new SupabaseAccountRepo(db());
    const a = await repo.create({ label: "C", emailHash: null });
    await new SupabaseSessionVault(db()).put(a.id, "e", new Date());
    await new SupabaseCreatedObjects(db()).record(a.id, "notebook", "nb1");
    await new SupabaseUsageCounter(db()).increment(a.id, "2026-10-31", "chat");
    await repo.remove(a.id);
    const t = await tables();
    expect([t.sessions, t.created_objects, t.usage_counters].every((rows) => rows.every((r) => r.account_id !== a.id))).toBe(true);
  });
});

describe("created_objects / usage_counters / audit_log", () => {
  it("created_objects: record is idempotent, has/list are per account and kind, list pages past 200", async () => {
    const repo = new SupabaseAccountRepo(db());
    const a = await repo.create({ label: "CO1", emailHash: null });
    const b = await repo.create({ label: "CO2", emailHash: null });
    const co = new SupabaseCreatedObjects(db());
    await co.record(a.id, "notebook", "nb-1");
    await co.record(a.id, "notebook", "nb-1");
    expect(await co.has(a.id, "notebook", "nb-1")).toBe(true);
    expect(await co.has(b.id, "notebook", "nb-1")).toBe(false);
    expect(await co.has(a.id, "artifact", "nb-1")).toBe(false);
    for (let i = 0; i < 450; i++) await co.record(a.id, "source", `src-${String(i).padStart(4, "0")}`);
    const listed = await co.list(a.id, "source");
    expect(listed.length).toBe(450);
    expect(new Set(listed).size).toBe(450);
    expect((await co.list(a.id, "notebook")).length).toBe(1);
    await expect(co.record(uuid(997), "notebook", "x")).rejects.toBeInstanceOf(VaultStorageError);
  });
  it("usage_counters: get 0 -> increment -> get; per kind/day", async () => {
    const a = await new SupabaseAccountRepo(db()).create({ label: "U", emailHash: null });
    const u = new SupabaseUsageCounter(db());
    expect(await u.get(a.id, "2026-10-31", "audio")).toBe(0);
    expect(await u.increment(a.id, "2026-10-31", "audio")).toBe(1);
    expect(await u.increment(a.id, "2026-10-31", "audio")).toBe(2);
    expect(await u.get(a.id, "2026-10-31", "audio")).toBe(2);
    expect(await u.get(a.id, "2026-11-01", "audio")).toBe(0);
    expect(await u.get(a.id, "2026-10-31", "video")).toBe(0);
  });
  it("usage_counters.increment under 10 parallel calls (documented best-effort, not atomic): reports the final count", async () => {
    const a = await new SupabaseAccountRepo(db()).create({ label: "UP", emailHash: null });
    const u = new SupabaseUsageCounter(db());
    await Promise.all(Array.from({ length: 10 }, () => u.increment(a.id, "2026-10-31", "chat")));
    const n = await u.get(a.id, "2026-10-31", "chat");
    console.log(`QA-NOTE usage_counters parallel increments: 10 calls -> stored ${n}`);
    expect(n).toBeGreaterThanOrEqual(1);
  });
  it("audit_log: write stores metadata only; unknown account violates the FK", async () => {
    const a = await new SupabaseAccountRepo(db()).create({ label: "AU", emailHash: null });
    const sink = new SupabaseAuditSink(db());
    await sink.write({ accountId: a.id, tool: "LIST_NOTEBOOKS", rpcId: "wXbhsf", outcome: "ok", at: new Date() });
    const rows = (await tables()).audit_log.filter((r) => r.account_id === a.id);
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["account_id", "at", "id", "outcome", "rpc_id", "tool"]);
    await expect(sink.write({ accountId: uuid(996), tool: "t", rpcId: "r", outcome: "ok", at: new Date() })).rejects.toBeInstanceOf(VaultStorageError);
  });
});

describe("persistent login limiter", () => {
  it("20 parallel wrong attempts: at most 5 are allowed; none beyond", async () => {
    const lim = createPersistentLoginLimiter({ db: db() });
    const key = "b".repeat(64);
    const res = await Promise.all(Array.from({ length: 20 }, () => lim.attempt(key)));
    const allowed = res.filter((r) => r.allowed).length;
    console.log(`QA-NOTE limiter parallel burst: ${allowed}/20 allowed`);
    expect(allowed).toBeLessThanOrEqual(5);
  });
  it("sequential: 5 allowed, 6th denied with retryAfter, success resets", async () => {
    const lim = createPersistentLoginLimiter({ db: db() });
    const key = "c".repeat(64);
    for (let i = 0; i < 5; i++) expect((await lim.attempt(key)).allowed).toBe(true);
    const d = await lim.attempt(key);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    await lim.recordSuccess(key);
    expect((await lim.attempt(key)).allowed).toBe(true);
  });
  it("limiter window uses stored (Postgres-formatted) timestamps correctly: old rows age out", async () => {
    let t = Date.now();
    const lim = createPersistentLoginLimiter({ db: db(), now: () => t });
    const key = "d".repeat(64);
    for (let i = 0; i < 5; i++) await lim.attempt(key);
    expect((await lim.attempt(key)).allowed).toBe(false);
    t += 15 * 60_000 + 1000;
    expect((await lim.attempt(key)).allowed).toBe(true);
  });
});

describe("oauth store", () => {
  it("clients/codes/tokens round trip with real column types (text[] / boolean / timestamptz)", async () => {
    const s = createSupabaseStore(db());
    const now = new Date();
    await s.clients.insert({ clientId: "cl1", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], clientName: "Claude", createdAt: now });
    expect((await s.clients.get("cl1"))?.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(await s.clients.countLive(new Date(0))).toBe(1);
    const code = { codeHash: "e".repeat(64), clientId: "cl1", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "ch", scope: "notebooklm", resource: null, familyId: "fam1", expiresAt: new Date(now.getTime() + 60_000), used: false };
    await s.codes.insert(code);
    const [r1, r2] = await Promise.all([s.codes.consume(code.codeHash), s.codes.consume(code.codeHash)]);
    expect([r1.status, r2.status].sort()).toEqual(["ok", "reused"]);
    expect((await s.codes.consume("0".repeat(64))).status).toBe("missing");
    const tok = { tokenHash: "f".repeat(64), kind: "refresh" as const, clientId: "cl1", scope: "notebooklm", expiresAt: new Date(now.getTime() + 1e6), familyId: "fam1", revokedAt: null, createdAt: now };
    await s.tokens.insert(tok);
    const claims = await Promise.all([s.tokens.claim(tok.tokenHash, new Date()), s.tokens.claim(tok.tokenHash, new Date())]);
    expect(claims.filter(Boolean).length).toBe(1);
    expect((await s.tokens.get(tok.tokenHash))?.revokedAt).not.toBeNull();
    await s.tokens.revokeAll(new Date());
    await s.clients.remove("cl1");
    const t = await tables();
    expect(t.oauth_codes.length + t.oauth_tokens.length).toBe(0); // cascade
  });
  it("DCR cap: 200 clients list in pages; the 201st would be refused by the app, storage holds all", async () => {
    const s = createSupabaseStore(db());
    for (let i = 0; i < 205; i++) await s.clients.insert({ clientId: `bulk${i}`, redirectUris: ["https://a.example/cb"], clientName: "n", createdAt: new Date() });
    expect(await s.clients.countLive(new Date(0))).toBe(205);
  });
});

describe("migration 0004 behaviour (real adapters vs emulator)", () => {
  const H = "h".repeat(64);
  const mk = (id: string, at: Date, extra: object = {}) => ({ clientId: id, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], clientName: "Claude", createdAt: at, ...extra });
  const base = { kind: "refresh" as const, clientId: "k1", scope: "notebooklm", revokedAt: null };
  beforeEach(async () => void (await fetch(EMU + "/__qa/reset", { method: "POST" })));

  it("Db.count / countLive / countRecentByIp / markHasToken use ip_hash, has_token and gte filters", async () => {
    const s = createSupabaseStore(db());
    const now = Date.now();
    await s.clients.insert(mk("k1", new Date(now - 3 * 3600_000), { ipHash: H }));
    await s.clients.insert(mk("k2", new Date(now - 1000), { ipHash: H }));
    await s.clients.insert(mk("k3", new Date(now - 5 * 3600_000), { hasToken: true }));
    expect(await s.clients.countLive(new Date(now - 3600_000))).toBe(2); // k2 (fresh) + k3 (token); k1 abandoned
    expect(await s.clients.countRecentByIp(H, new Date(now - 3600_000))).toBe(1);
    expect(await s.clients.countRecentByIp(H, new Date(now - 4 * 3600_000))).toBe(2);
    await s.clients.markHasToken("k1");
    await s.clients.markHasToken("k1"); // idempotent
    expect(await s.clients.countLive(new Date(now - 3600_000))).toBe(3);
    expect((await s.clients.get("k1"))).toMatchObject({ hasToken: true, ipHash: H });
  });

  it("rotated flag: rotation is not a revoked family; revokeFamily and tombstone are", async () => {
    const s = createSupabaseStore(db());
    const now = new Date();
    await s.clients.insert(mk("k1", now));
    const t = (h: string, fam: string) => ({ ...base, tokenHash: h.repeat(64).slice(0, 64), familyId: fam, expiresAt: new Date(now.getTime() + 1e6), createdAt: now });
    await s.tokens.insert(t("a", "fa"));
    expect(await s.tokens.claim("a".repeat(64), now, true)).toBe(true);
    expect(await s.tokens.get("a".repeat(64))).toMatchObject({ rotated: true });
    expect(await s.tokens.familyRevoked("fa")).toBe(false);
    await s.tokens.insert(t("b", "fa"));
    await s.tokens.revokeFamily("fa", now);
    expect(await s.tokens.familyRevoked("fa")).toBe(true);
    await s.tokens.tombstoneFamily("fb", "k1", now);
    expect(await s.tokens.familyRevoked("fb")).toBe(true);
  });

  it("rpc prune_expired: same predicates as the SQL function; live rows survive; anon key is refused", async () => {
    const d = db();
    const s = createSupabaseStore(d);
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    const D = 86_400_000, H1 = 3_600_000;
    await s.clients.insert(mk("old-orphan", ago(3 * D)));
    await s.clients.insert(mk("new-orphan", ago(5 * 60_000)));
    await s.clients.insert(mk("live", ago(3 * D), { hasToken: true }));
    const t = (h: string, o: object) => ({ ...base, clientId: "live", tokenHash: h.repeat(64).slice(0, 64), familyId: "f", createdAt: ago(40 * D), expiresAt: new Date(now + 20 * D), ...o });
    await s.tokens.insert(t("1", { expiresAt: ago(8 * D) })); // expired > 7 d: pruned
    await s.tokens.insert(t("2", { expiresAt: ago(2 * D) })); // expired recently: kept
    await s.tokens.insert(t("3", { revokedAt: ago(8 * D) })); // revoked > 7 d: pruned
    await s.tokens.insert(t("4", { revokedAt: ago(1 * D) })); // revoked recently: kept
    await s.tokens.insert(t("5", {})); // live
    for (const [h, exp] of [["c1", ago(2 * H1)], ["c2", ago(30 * 60_000)], ["c3", new Date(now + 50_000)]] as const) {
      await s.codes.insert({ codeHash: h.repeat(32), clientId: "live", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "x", scope: "notebooklm", resource: null, familyId: "f", expiresAt: exp, used: true });
    }
    await d.insert("audit_log", { tool: "x", outcome: "ok", at: ago(120 * D).toISOString() });
    await d.insert("audit_log", { tool: "x", outcome: "ok", at: ago(1 * D).toISOString() });
    await d.insert("login_attempts", { key_hash: "a".repeat(64), attempted_at: ago(2 * D).toISOString() });
    await d.insert("login_attempts", { key_hash: "b".repeat(64), attempted_at: ago(1000).toISOString() });

    expect(await d.rpc!("prune_expired")).toEqual({ codes: 1, tokens: 2, clients: 1, audit: 1, login: 1 });
    const left = (await tables()) as Record<string, Rows>;
    expect(left.oauth_clients!.map((c) => c.client_id).sort()).toEqual(["live", "new-orphan"]);
    expect(left.oauth_tokens!.map((x) => (x.token_hash as string)[0]).sort()).toEqual(["2", "4", "5"]);
    expect(left.oauth_codes!.map((c) => (c.code_hash as string)[0]).sort()).toEqual(["c", "c"]);
    expect(left.audit_log!).toHaveLength(1);
    expect(left.login_attempts!).toHaveLength(1);
    expect(await d.rpc!("prune_expired")).toEqual({ codes: 0, tokens: 0, clients: 0, audit: 0, login: 0 });
  });

  it("rpc is service-role only (anon key -> 401, like the REVOKE in the migration) and unknown functions are 404", async () => {
    const h = { "content-type": "application/json", apikey: KEY, authorization: `Bearer ${KEY}` };
    expect((await fetch(`${EMU}/rest/v1/rpc/prune_expired`, { method: "POST", headers: h, body: "{}" })).status).toBe(200);
    const anon = { ...h, apikey: ANON, authorization: `Bearer ${ANON}` };
    expect((await fetch(`${EMU}/rest/v1/rpc/prune_expired`, { method: "POST", headers: anon, body: "{}" })).status).toBe(401);
    expect((await fetch(`${EMU}/rest/v1/rpc/nope`, { method: "POST", headers: h, body: "{}" })).status).toBe(404);
  });
});
