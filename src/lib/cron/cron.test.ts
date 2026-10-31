// Synthetic data only. No network: Google is a scripted fake fetch.
import { describe, expect, it } from "vitest";
import { AccountNeedsReauthError, CooldownActiveError, RegionGateError } from "@/lib/google/errors";
import { createRotationLimiter } from "@/lib/google/keepalive";
import { createThrottle } from "@/lib/google/throttle";
import { fakeClock, homepageHtml, res, scriptedFetch, synthJar, SYN_SID } from "@/lib/google/testing";
import { RpcAuthError, RpcDriftError, RpcQuotaError } from "@/lib/rpc/errors";
import type { Account } from "@/lib/vault/storage";
import { authorizeCron } from "./auth";
import { classifyHealthError, runDeepHealth } from "./deep-health";
import { handleDeepHealth, handleKeepAlive } from "./handlers";
import { runKeepAliveSweep, type SweepDeps } from "./keepalive";

const SECRET = "cron-secret-synthetic";
const env = { CRON_SECRET: SECRET };
const acct = (i: number, status: Account["status"] = "active"): Account => ({
  id: `acc-${i}`,
  label: `Label-${i}`,
  emailHash: null,
  status,
  createdAt: new Date(0),
});
const req = (auth?: string, method = "GET") => new Request("https://x.test/api/cron/keepalive", { method, headers: auth ? { authorization: auth } : {} });

describe("authorizeCron", () => {
  it("fails closed with 503 when CRON_SECRET is unset or blank", async () => {
    for (const e of [{}, { CRON_SECRET: "  " }]) {
      expect(authorizeCron(req(`Bearer ${SECRET}`), e)?.status).toBe(503);
    }
  });
  it("401 on missing, wrong or malformed bearer; null on the right one", () => {
    expect(authorizeCron(req(), env)?.status).toBe(401);
    expect(authorizeCron(req("Bearer nope"), env)?.status).toBe(401);
    expect(authorizeCron(req(SECRET), env)?.status).toBe(401);
    expect(authorizeCron(req(`Bearer ${SECRET}`), env)).toBeNull();
  });
});

function sweepSetup(accounts: Account[], opts: { budgetMs?: number; fetchStatus?: number } = {}) {
  const clock = fakeClock();
  const jars = new Map(accounts.map((a) => [a.id, synthJar()]));
  const statuses: string[] = [];
  const order: string[] = [];
  const { fetch, calls } = scriptedFetch(accounts.map(() => () => res(opts.fetchStatus ?? 200)));
  const deps: SweepDeps = {
    vault: {
      listAccounts: async () => accounts,
      getJar: async (id) => {
        order.push(id);
        return jars.get(id)!;
      },
      updateJar: async () => undefined,
    },
    accounts: { setStatus: async (id, s) => void statuses.push(`${id}:${s}`) },
    fetch,
    limiter: createRotationLimiter({ now: clock.now }),
    throttle: createThrottle({ now: clock.now, sleep: clock.sleep, random: () => 0 }),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    budgetMs: opts.budgetMs,
  };
  return { deps, calls, statuses, order, clock };
}

describe("runKeepAliveSweep", () => {
  it("handles only ACTIVE accounts, sequentially, with a gap between accounts", async () => {
    const s = sweepSetup([acct(1), acct(2, "disabled"), acct(3), acct(4, "needs_reauth")]);
    const t0 = s.clock.now();
    const r = await runKeepAliveSweep(s.deps);
    expect(r).toEqual({
      results: [
        { id: "acc-1", status: "rotated" },
        { id: "acc-3", status: "rotated" },
      ],
      processed: 2,
      skipped: 0,
      budgetExhausted: false,
    });
    expect(s.order).toEqual(["acc-1", "acc-3"]);
    expect(s.clock.now() - t0).toBeGreaterThanOrEqual(1500); // MIN_GAP between the two accounts
    expect(s.calls).toHaveLength(2);
  });

  it("stops gracefully when the budget runs out and reports how many were skipped", async () => {
    const s = sweepSetup([acct(1), acct(2), acct(3), acct(4)], { budgetMs: 5_000 });
    const r = await runKeepAliveSweep(s.deps);
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect(r.processed).toBeLessThan(4);
    expect(r.skipped).toBe(4 - r.processed);
    expect(r.budgetExhausted).toBe(true);
    expect(r.results.map((x) => x.id)).toEqual(["acc-1", "acc-2", "acc-3", "acc-4"].slice(0, r.processed));
  });

  it("a 401 confirmed signed-out by the probe marks needs_reauth; a 403 with a live probe stays active (error); a failing account does not stop the others", async () => {
    const clock = fakeClock();
    const accounts = [acct(1), acct(2), acct(3)];
    const { fetch } = scriptedFetch([
      () => res(401),
      () => res(200, { body: '<a class="landing-header-signin">Sign in</a>' }),
      () => res(403),
      () => res(200, { body: homepageHtml() }),
      () => res(200),
    ]);
    const statuses: string[] = [];
    const r = await runKeepAliveSweep({
      vault: { listAccounts: async () => accounts, getJar: async () => synthJar(), updateJar: async () => undefined },
      accounts: { setStatus: async (id, st) => void statuses.push(`${id}:${st}`) },
      fetch,
      limiter: createRotationLimiter({ now: clock.now }),
      throttle: createThrottle({ now: clock.now, sleep: clock.sleep, random: () => 0 }),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      probeBase: "https://notebooklm.google.com",
    });
    expect(r.results).toEqual([
      { id: "acc-1", status: "needs_reauth" },
      { id: "acc-2", status: "error" },
      { id: "acc-3", status: "rotated" },
    ]);
    expect(statuses).toEqual(["acc-1:needs_reauth"]);
  });

  it("maps a cooldown and a vault failure to statuses without leaking error text", async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ now: clock.now, sleep: clock.sleep, random: () => 0 });
    throttle.noteQuota("acc-1");
    const { fetch } = scriptedFetch([]);
    const r = await runKeepAliveSweep({
      vault: {
        listAccounts: async () => [acct(1), acct(2)],
        getJar: async () => {
          throw new Error(`boom ${SYN_SID}`);
        },
        updateJar: async () => undefined,
      },
      accounts: { setStatus: async () => undefined },
      fetch,
      limiter: createRotationLimiter({ now: clock.now }),
      throttle,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });
    expect(r.results).toEqual([
      { id: "acc-1", status: "cooldown" },
      { id: "acc-2", status: "error" },
    ]);
    expect(JSON.stringify(r)).not.toContain(SYN_SID);
  });

  it("zero active accounts is a clean no-op", async () => {
    const s = sweepSetup([acct(1, "disabled")]);
    expect(await runKeepAliveSweep(s.deps)).toEqual({ results: [], processed: 0, skipped: 0, budgetExhausted: false });
  });
});

describe("handlers", () => {
  const sweepDeps = () => sweepSetup([acct(1)]).deps;

  it("keep-alive: 401/503 before touching deps; GET and POST both work with the bearer", async () => {
    let touched = false;
    const getDeps = () => {
      touched = true;
      return sweepDeps();
    };
    expect((await handleKeepAlive(req(), { env, getDeps })).status).toBe(401);
    expect((await handleKeepAlive(req(`Bearer ${SECRET}`), { env: {}, getDeps })).status).toBe(503);
    expect(touched).toBe(false);
    for (const m of ["GET", "POST"]) {
      const r = await handleKeepAlive(req(`Bearer ${SECRET}`, m), { env, getDeps: () => sweepSetup([acct(1)]).deps });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const body = (await r.json()) as { results: unknown[]; processed: number };
      expect(body.processed).toBe(1);
    }
  });

  it("keep-alive: prune runs after the sweep, also after a failed sweep, never on 401/503, and its errors never change the response", async () => {
    let pruned = 0;
    const prune = async () => void pruned++;
    expect((await handleKeepAlive(req(), { env, getDeps: sweepDeps, prune })).status).toBe(401);
    expect((await handleKeepAlive(req(`Bearer ${SECRET}`), { env, getDeps: () => { throw new Error("x"); }, prune })).status).toBe(503);
    expect(pruned).toBe(0);
    const ok = await handleKeepAlive(req(`Bearer ${SECRET}`), { env, getDeps: sweepDeps, prune });
    expect(ok.status).toBe(200);
    expect(pruned).toBe(1);
    const failedSweep = await handleKeepAlive(req(`Bearer ${SECRET}`), { env, getDeps: () => ({ ...sweepDeps(), vault: { ...sweepDeps().vault, listAccounts: async () => Promise.reject(new Error("db")) } }), prune });
    expect(failedSweep.status).toBe(500);
    expect(pruned).toBe(2);
    for (const bad of [async () => Promise.reject(new Error("rpc down")), () => { throw new Error("sync"); }]) {
      const r = await handleKeepAlive(req(`Bearer ${SECRET}`), { env, getDeps: sweepDeps, prune: bad as () => Promise<unknown> });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { processed: number }).processed).toBe(1);
    }
  });

  it("keep-alive: unconfigured storage is a generic 503; a crash is a generic 500", async () => {
    const a = await handleKeepAlive(req(`Bearer ${SECRET}`), {
      env,
      getDeps: () => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY secret-ish");
      },
    });
    expect(a.status).toBe(503);
    expect(await a.text()).not.toContain("secret-ish");
    const b = await handleKeepAlive(req(`Bearer ${SECRET}`), {
      env,
      getDeps: () => ({ ...sweepDeps(), vault: { ...sweepDeps().vault, listAccounts: async () => Promise.reject(new Error("db password hunter2")) } }),
    });
    expect(b.status).toBe(500);
    expect(await b.text()).not.toContain("hunter2");
  });

  it("deep health: same gate, then per-account statuses only", async () => {
    const getDeps = () => ({ listAccounts: async () => [acct(1)], listNotebooks: async () => ({ notebooks: [{ title: "Secret Notebook Name" }] }) });
    expect((await handleDeepHealth(req(), { env, getDeps })).status).toBe(401);
    expect((await handleDeepHealth(req(`Bearer ${SECRET}`), { env: {}, getDeps })).status).toBe(503);
    const r = await handleDeepHealth(req(`Bearer ${SECRET}`), { env, getDeps });
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ accounts: [{ id: "acc-1", status: "ok" }] });
    expect(text).not.toContain("Secret Notebook Name");
    expect(text).not.toContain("Label-1");
  });
});

describe("deep health", () => {
  it("classifies errors into the documented statuses", () => {
    expect(classifyHealthError(new AccountNeedsReauthError("a"))).toBe("needs_reauth");
    expect(classifyHealthError(new RpcAuthError("x", "grpc_16"))).toBe("needs_reauth");
    expect(classifyHealthError(new RegionGateError("h"))).toBe("region_gate");
    expect(classifyHealthError(new RpcDriftError("x", ["y"]))).toBe("drift");
    expect(classifyHealthError(new RpcQuotaError("x", "grpc_8"))).toBe("quota");
    expect(classifyHealthError(new CooldownActiveError("a", 1000))).toBe("quota");
    expect(classifyHealthError(new Error("anything"))).toBe("error");
  });

  it("asks for one notebook per active account, sequentially, and survives failures", async () => {
    const calls: string[] = [];
    const r = await runDeepHealth({
      listAccounts: async () => [acct(1), acct(2, "disabled"), acct(3), acct(4)],
      listNotebooks: async (id, opts) => {
        calls.push(`${id}:${opts.limit}`);
        if (id === "acc-3") throw new RegionGateError("h");
        if (id === "acc-4") throw new Error("kaboom");
        return {};
      },
    });
    expect(calls).toEqual(["acc-1:1", "acc-3:1", "acc-4:1"]);
    expect(r.accounts).toEqual([
      { id: "acc-1", status: "ok" },
      { id: "acc-3", status: "region_gate" },
      { id: "acc-4", status: "error" },
    ]);
  });
});
