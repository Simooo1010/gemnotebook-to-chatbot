import { describe, expect, it } from "vitest";
import { RpcDriftError, RpcQuotaError } from "@/lib/rpc/errors";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { VaultError, createVault } from "@/lib/vault/vault";
import { createGoogleClient, type AuditRow } from "./client";
import { AccountNeedsReauthError, AmbiguousMutationError, CooldownActiveError, HttpStatusError, RegionGateError, StaleTokenMutationError } from "./errors";
import { createThrottle } from "./throttle";
import {
  SYN_AT,
  SYN_SID,
  SYN_TS,
  batchBody,
  batchStatusBody,
  fakeClock,
  homepageHtml,
  res,
  scriptedFetch,
  synthJar,
  type Handler,
} from "./testing";

const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), VAULT_KEY_VERSION: "1" });
const rotateOk: Handler = () => res(200, { setCookie: ["SIDCC=SYNTHETIC_SIDCC_x3; Domain=.google.com; Path=/; Secure"] });
const home: Handler = () => res(200, { body: homepageHtml() });
const LIST = "wXbhsf";
const CREATE = "CCqFvf";

async function setup(handlers: Handler[], cfg: { overrides?: string } = {}) {
  const clock = fakeClock();
  const accounts = new MemoryAccountRepo();
  const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
  const { account } = await vault.connectAccount("Synthetic", synthJar().cookies);
  const { fetch, calls } = scriptedFetch(handlers);
  const audit: AuditRow[] = [];
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep, backoffBaseMs: 1000 });
  const client = createGoogleClient({
    fetch,
    vault,
    accounts,
    throttle,
    audit: { write: async (r) => void audit.push(r) },
    config: { base: "https://notebook.google.com", rpcOverridesJson: cfg.overrides },
    now: clock.now,
  });
  return { client, calls, audit, accounts, vault, id: account.id, throttle, clock };
}

const read = (id: string) => ({ accountId: id, name: "LIST_NOTEBOOKS" as const, params: [null, 1, null, [2]], kind: "read" as const });
const mutate = (id: string) => ({ accountId: id, name: "CREATE_NOTEBOOK" as const, params: ["t"], kind: "mutate" as const });

function noSecrets(s: string) {
  for (const v of [SYN_SID, SYN_TS, SYN_AT, "SYNTHETIC_SIDCC_x3"]) expect(s).not.toContain(v);
}

describe("google client", () => {
  it("read: rotate → tokens → POST batchexecute → decoded result, jar persisted, clean audit row", async () => {
    const s = await setup([rotateOk, home, () => res(200, { body: batchBody(LIST, [["nb"]]) })]);
    expect(await s.client.rpc(read(s.id))).toEqual([["nb"]]);
    const post = s.calls[2]!;
    expect(post.url).toContain("/_/LabsTailwindUi/data/batchexecute?rpcids=wXbhsf");
    expect(post.url).toContain("f.sid=-1234567890123456789");
    expect(post.init.body).toContain(`at=${SYN_AT}`);
    expect(post.init.headers!.Cookie).toContain(`SID=${SYN_SID}`);
    expect(post.init.headers!.Cookie).toContain("SIDCC=");
    expect((await s.vault.getJar(s.id)).cookies.some((c) => c.name === "SIDCC")).toBe(true);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ accountId: s.id, tool: "LIST_NOTEBOOKS", rpcId: LIST, outcome: "ok" });
    expect(Object.keys(s.audit[0]!).sort()).toEqual(["accountId", "at", "outcome", "rpcId", "tool"]);
    noSecrets(JSON.stringify(s.audit));
  });

  it("T3-11: homepage without cfb2h → batchexecute URL has no bl parameter (never an empty bl=)", async () => {
    const noBl: Handler = () => res(200, { body: homepageHtml().replace(/,"cfb2h":"[^"]*"/, "") });
    const s = await setup([rotateOk, noBl, () => res(200, { body: batchBody(LIST, [["nb"]]) })]);
    await s.client.rpc(read(s.id));
    expect(s.calls[2]!.url).not.toMatch(/[?&]bl=/);
    expect(s.calls[2]!.url).toContain("rpcids=wXbhsf");
  });

  it("caches tokens: the second call only POSTs", async () => {
    const ok = () => res(200, { body: batchBody(LIST, [1]) });
    const s = await setup([rotateOk, home, ok, ok]);
    await s.client.rpc(read(s.id));
    await s.client.rpc(read(s.id));
    expect(s.calls).toHaveLength(4);
  });

  it("uses RPC id overrides", async () => {
    const s = await setup([rotateOk, home, () => res(200, { body: batchBody("NewId1", [1]) })], {
      overrides: '{"LIST_NOTEBOOKS":"NewId1"}',
    });
    await s.client.rpc(read(s.id));
    expect(s.calls[2]!.url).toContain("rpcids=NewId1");
    expect(s.audit[0]!.rpcId).toBe("NewId1");
  });

  it("read: 401 → refresh tokens once and retry once", async () => {
    const s = await setup([rotateOk, home, () => res(401), home, () => res(200, { body: batchBody(LIST, [2]) })]);
    expect(await s.client.rpc(read(s.id))).toEqual([2]);
    expect(s.calls).toHaveLength(5); // rotation rate-limited on the refresh
    expect((await s.accounts.get(s.id))!.status).toBe("active");
  });

  it("read: still failing after one retry → needs_reauth", async () => {
    const s = await setup([rotateOk, home, () => res(403), home, () => res(200, { body: batchStatusBody(LIST, 16) })]);
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect((await s.accounts.get(s.id))!.status).toBe("needs_reauth");
    expect(s.audit[0]!.outcome).toBe("error:needs_reauth");
    // non-active account is refused by the vault before any network
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(VaultError);
    expect(s.calls).toHaveLength(5);
  });

  it("T3-4 read: HTTP 400 (expired at token) → refresh tokens once, retry once, account stays active", async () => {
    const s = await setup([rotateOk, home, () => res(400, { body: `)]}'\n\n[["wrb.fr","${LIST}","[\\"INVALID_CREDENTIALS\\"]"]]` }), home, () => res(200, { body: batchBody(LIST, [2]) })]);
    expect(await s.client.rpc(read(s.id))).toEqual([2]);
    expect(s.calls).toHaveLength(5);
    expect(s.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(2);
    expect((await s.accounts.get(s.id))!.status).toBe("active");
  });

  it("T3-4 read: a 400 that persists with a live session is an HTTP error, not needs_reauth", async () => {
    const s = await setup([rotateOk, home, () => res(400), home, () => res(400)]);
    const e = (await s.client.rpc(read(s.id)).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(HttpStatusError);
    expect(s.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(2);
    expect((await s.accounts.get(s.id))!.status).toBe("active");
  });

  it("T3-4 mutation: HTTP 400 + live session → stale-token ambiguity, never retried; signed-out probe → needs_reauth", async () => {
    const s = await setup([rotateOk, home, () => res(400), home]);
    const e = (await s.client.rpc(mutate(s.id)).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(StaleTokenMutationError);
    expect(s.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(1);
    expect((await s.accounts.get(s.id))!.status).toBe("active");
    const t = await setup([rotateOk, home, () => res(400), () => res(302, { location: "https://accounts.google.com/ServiceLogin" }), () => res(200, { body: "x" })]);
    await expect(t.client.rpc(mutate(t.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect(t.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(1);
  });

  it("mutation: auth failure + signed-out probe → needs_reauth, write never retried", async () => {
    const s = await setup([rotateOk, home, () => res(401), () => res(302, { location: "https://accounts.google.com/ServiceLogin" }), () => res(200, { body: "x" })]);
    await expect(s.client.rpc(mutate(s.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect(s.calls).toHaveLength(5);
    expect(s.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(1);
    expect((await s.accounts.get(s.id))!.status).toBe("needs_reauth");
  });

  it("mutation: auth failure + cookie mismatch probe → needs_reauth", async () => {
    const s = await setup([rotateOk, home, () => res(401), () => res(302, { location: "https://accounts.google.com/CookieMismatch" }), () => res(200, { body: "x" })]);
    await expect(s.client.rpc(mutate(s.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect((await s.accounts.get(s.id))!.status).toBe("needs_reauth");
  });

  it("mutation: auth failure but session alive (stale token) → not confirmed, account stays active, tokens refreshed", async () => {
    const s = await setup([rotateOk, home, () => res(401), home, () => res(200, { body: batchBody(LIST, [1]) })]);
    const e = (await s.client.rpc(mutate(s.id)).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(AmbiguousMutationError);
    expect(e.message).toMatch(/NOT confirmed/);
    expect((await s.accounts.get(s.id))!.status).toBe("active");
    expect(s.calls.filter((c) => c.url.includes("batchexecute"))).toHaveLength(1); // not retried
    expect(s.audit[0]!.outcome).toBe("error:ambiguous_mutation");
    // token cache was refreshed: the next call only POSTs
    await s.client.rpc(read(s.id));
    expect(s.calls).toHaveLength(5);
  });

  it("mutation: 5xx, code 3 and network errors are ambiguous and not retried", async () => {
    const s = await setup([
      rotateOk,
      home,
      () => res(503),
      () => res(200, { body: batchStatusBody(CREATE, 3) }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    for (let i = 0; i < 3; i++) {
      const e = (await s.client.rpc(mutate(s.id)).catch((x: unknown) => x)) as Error;
      expect(e).toBeInstanceOf(AmbiguousMutationError);
      expect(e.message).toMatch(/Reconcile by listing/);
    }
    expect(s.calls).toHaveLength(5);
  });

  it("quota/429: sets cooldown, not retried, next call refused locally", async () => {
    const s = await setup([rotateOk, home, () => res(429, { headers: { "retry-after": "7" } })]);
    const e = (await s.client.rpc(read(s.id)).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(RpcQuotaError);
    expect(s.throttle.cooldownRemainingMs(s.id)).toBe(7000);
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(CooldownActiveError);
    expect(s.calls).toHaveLength(3);
    expect(s.audit.map((a) => a.outcome)).toEqual(["error:quota", "error:cooldown"]);
  });

  it("drift is surfaced as-is, not retried", async () => {
    const s = await setup([rotateOk, home, () => res(200, { body: batchBody("OtherId", [1]) })]);
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(RpcDriftError);
    expect(s.calls).toHaveLength(3);
    expect(s.audit[0]!.outcome).toBe("error:drift");
  });

  it("region gate is surfaced, account stays active", async () => {
    const s = await setup([rotateOk, () => res(302, { location: "https://notebook.google.com/?location=unsupported" }), home]);
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(RegionGateError);
    expect((await s.accounts.get(s.id))!.status).toBe("active");
  });

  it("signed-out homepage → needs_reauth; audit rows never contain secrets", async () => {
    const s = await setup([rotateOk, () => res(302, { location: "https://accounts.google.com/ServiceLogin" }), () => res(200, { body: "x" })]);
    await expect(s.client.rpc(read(s.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    noSecrets(JSON.stringify(s.audit));
  });
});
