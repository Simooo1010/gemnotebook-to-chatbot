import { describe, expect, it } from "vitest";
import { createLoginLimiter } from "@/lib/auth/passphrase";
import { cookieName, createSessionToken } from "@/lib/auth/session";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";
import {
  handleImport,
  handleKill,
  handleListAccounts,
  handleLogin,
  handleLogout,
  handleRevokeAll,
  type OwnerDeps,
} from "./handlers";

const BASE = "https://app.example.com";
const PASS = "correct horse battery staple";
const env = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: BASE,
  OAUTH_SIGNING_KEY: "s".repeat(40),
  OWNER_PASSPHRASE: PASS,
};
const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), VAULT_KEY_VERSION: "1" });
const cookies = [
  { name: "SID", value: "SECRET-SID-VALUE", domain: ".google.com", path: "/", secure: true, httpOnly: true },
  { name: "__Secure-1PSIDTS", value: "SECRET-TS-VALUE", domain: ".google.com", path: "/", secure: true, httpOnly: true },
  { name: "NID", value: "SECRET-NID-VALUE", domain: ".google.com", path: "/", secure: true, httpOnly: false },
];

function setup(over: Partial<OwnerDeps> = {}) {
  const accounts = new MemoryAccountRepo();
  const sessions = new MemorySessionVault();
  const vault = createVault({ accounts, sessions, keyring });
  const sleeps: number[] = [];
  const deps: OwnerDeps = {
    env,
    limiter: createLoginLimiter(),
    getVault: () => vault,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...over,
  };
  return { deps, vault, accounts, sessions, sleeps };
}

const ownerCookie = () => `${cookieName(true)}=${createSessionToken(env).token}`;
const post = (path: string, body?: unknown, h: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json", ...h },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const authed = (path: string, body?: unknown, h: Record<string, string> = {}) => post(path, body, { cookie: ownerCookie(), ...h });
const get = (path: string, h: Record<string, string> = {}) => new Request(`${BASE}${path}`, { headers: h });

const importBody = (label = "Main", c: unknown = cookies) => ({ label, json: JSON.stringify(c) });
const text = async (r: Response) => r.text();

describe("login", () => {
  it("accepts the right passphrase and sets a hardened cookie", async () => {
    const { deps } = setup();
    const res = await handleLogin(post("/api/owner/login", { passphrase: PASS }), deps);
    expect(res.status).toBe(200);
    const c = res.headers.get("set-cookie")!;
    expect(c).toMatch(/^__Host-owner=/);
    for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(c).toContain(a);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await text(res)).not.toContain(PASS);
  });

  it("wrong passphrase: generic 401, no cookie, delay applied", async () => {
    const { deps, sleeps } = setup();
    const res = await handleLogin(post("/api/owner/login", { passphrase: "nope" }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await text(res);
    expect(body).not.toContain("nope");
    expect(JSON.parse(body).error.code).toBe("invalid_credentials");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(600);
  });

  it("same generic error for bad body, missing passphrase, and unconfigured owner", async () => {
    const { deps } = setup();
    const a = await text(await handleLogin(post("/api/owner/login", { passphrase: "x" }), deps));
    const b = await text(await handleLogin(new Request(`${BASE}/api/owner/login`, { method: "POST", headers: { origin: BASE }, body: "{not json" }), deps));
    const c = await text(await handleLogin(post("/api/owner/login", {}), deps));
    const d = await text(await handleLogin(post("/api/owner/login", { passphrase: PASS }), setup({ env: { ...env, OWNER_PASSPHRASE: "" } }).deps));
    expect(new Set([a, b, c, d]).size).toBe(1);
  });

  it("rejects cross-origin and missing-origin before touching the limiter", async () => {
    const { deps } = setup();
    const evil = await handleLogin(post("/api/owner/login", { passphrase: PASS }, { origin: "https://evil.example" }), deps);
    expect(evil.status).toBe(403);
    const none = await handleLogin(new Request(`${BASE}/api/owner/login`, { method: "POST", body: "{}" }), deps);
    expect(none.status).toBe(403);
  });

  it("locks out after repeated failures per client, then returns 429 even for the right passphrase", async () => {
    let t = 0;
    const limiter = createLoginLimiter({ maxFailures: 3, now: () => t });
    const { deps } = setup({ limiter });
    const ip = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    for (let i = 0; i < 3; i++) expect((await handleLogin(post("/api/owner/login", { passphrase: "bad" }, ip), deps)).status).toBe(401);
    const locked = await handleLogin(post("/api/owner/login", { passphrase: PASS }, ip), deps);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // another client is unaffected
    expect((await handleLogin(post("/api/owner/login", { passphrase: PASS }, { "x-forwarded-for": "198.51.100.1" }), deps)).status).toBe(200);
    t += 16 * 60_000;
    expect((await handleLogin(post("/api/owner/login", { passphrase: PASS }, ip), deps)).status).toBe(200);
  });

  it("503 (not a crash, no secrets) when the signing key is short", async () => {
    const { deps } = setup({ env: { ...env, OAUTH_SIGNING_KEY: "short" } });
    const res = await handleLogin(post("/api/owner/login", { passphrase: PASS }), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("oversized body is treated as a failed login", async () => {
    const { deps } = setup();
    const res = await handleLogin(post("/api/owner/login", { passphrase: "a".repeat(10_000) }), deps);
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("clears the cookie, requires same origin", () => {
    const { deps } = setup();
    const ok = handleLogout(post("/api/owner/logout"), deps);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(handleLogout(post("/api/owner/logout", undefined, { origin: "https://evil.example" }), deps).status).toBe(403);
  });
});

describe("auth + CSRF on every vault route", () => {
  const routes: [string, (req: Request, d: OwnerDeps) => Promise<Response>, (h?: Record<string, string>) => Request][] = [
    ["list", handleListAccounts, (h) => get("/api/vault/accounts", h)],
    ["import", handleImport, (h) => post("/api/vault/accounts", importBody(), h)],
    ["kill", (r, d) => handleKill(r, "00000000-0000-4000-8000-000000000001", d), (h) => post("/api/vault/accounts/x/kill", undefined, h)],
    ["revoke-all", handleRevokeAll, (h) => post("/api/vault/revoke-all", undefined, h)],
  ];

  for (const [name, handler, mk] of routes) {
    it(`${name}: 401 without a session, 401 with a forged/expired one`, async () => {
      const { deps, accounts } = setup();
      expect((await handler(mk(), deps)).status).toBe(401);
      expect((await handler(mk({ cookie: `${cookieName(true)}=forged.token` }), deps)).status).toBe(401);
      const old = createSessionToken(env, Date.now() - 13 * 3600_000).token;
      expect((await handler(mk({ cookie: `${cookieName(true)}=${old}` }), deps)).status).toBe(401);
      expect(await accounts.list()).toHaveLength(0);
    });

    it(`${name}: no-store`, async () => {
      const { deps } = setup();
      expect((await handler(mk(), deps)).headers.get("cache-control")).toBe("no-store");
    });
  }

  for (const [name, handler, mk] of routes.filter(([n]) => n !== "list")) {
    it(`${name}: 403 for cross-origin or missing Origin even with a valid session`, async () => {
      const { deps, accounts } = setup();
      const c = { cookie: ownerCookie() };
      expect((await handler(mk({ ...c, origin: "https://evil.example" }), deps)).status).toBe(403);
      expect((await handler(mk({ ...c, "sec-fetch-site": "cross-site" }), deps)).status).toBe(403);
      const noOrigin = new Request(`${BASE}/api/x`, { method: "POST", headers: c, body: JSON.stringify(importBody()) });
      expect((await handler(noOrigin, deps)).status).toBe(403);
      expect(await accounts.list()).toHaveLength(0);
    });
  }

  it("503 when the vault is not configured, without details", async () => {
    const { deps } = setup({
      getVault: () => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY=leaky-value");
      },
    });
    const res = await handleListAccounts(get("/api/vault/accounts", { cookie: ownerCookie() }), deps);
    expect(res.status).toBe(503);
    expect(await text(res)).not.toContain("leaky-value");
  });
});

describe("import", () => {
  it("stores ciphertext, returns a secret-free account and never echoes cookie values", async () => {
    const { deps, sessions } = setup();
    const res = await handleImport(authed("/api/vault/accounts", importBody("Work")), deps);
    expect(res.status).toBe(201);
    const body = await text(res);
    expect(body).not.toMatch(/SECRET-/);
    const j = JSON.parse(body);
    expect(j.account).toMatchObject({ label: "Work", status: "active", cookieNameCount: 3 });
    expect((await sessions.get(j.account.id))!.envelope).not.toContain("SECRET-SID-VALUE");
  });

  it("missing cookies: typed error with NAMES only, no values, nothing stored", async () => {
    const { deps, accounts } = setup();
    const res = await handleImport(authed("/api/vault/accounts", importBody("X", [cookies[0]])), deps);
    expect(res.status).toBe(400);
    const body = await text(res);
    const j = JSON.parse(body);
    expect(j.error.code).toBe("missing_required");
    expect(j.error.missing).toEqual(["__Secure-1PSIDTS"]);
    expect(body).not.toContain("SECRET-");
    expect(await accounts.list()).toHaveLength(0);
  });

  it("missing cookies from a FOREIGN JarError copy (other module graph): still 400 with names only", async () => {
    // Structurally equal to JarError but not an instance of the imported class.
    class JarError extends Error {
      constructor(readonly code: string, readonly missing: string[]) {
        super(`missing required cookies: ${missing.join(", ")}`);
        this.name = "JarError";
      }
    }
    const foreign = new JarError("missing_required", ["SID", "__Secure-1PSIDTS"]);
    const { deps, vault } = setup();
    const fake = { ...vault, connectAccount: async () => { throw foreign; } } as typeof vault;
    const res = await handleImport(authed("/api/vault/accounts", importBody("X")), { ...deps, getVault: () => fake });
    expect(res.status).toBe(400);
    const body = await text(res);
    const j = JSON.parse(body);
    expect(j.error.code).toBe("missing_required");
    expect(j.error.missing).toEqual(["SID", "__Secure-1PSIDTS"]);
    expect(body).not.toContain("SECRET-");
  });

  it("a foreign VaultError copy maps like the real one; a look-alike without a code stays a generic 500", async () => {
    const { deps, vault } = setup();
    const foreignVault = Object.assign(new Error("vault: not_active"), { name: "VaultError", code: "not_active" });
    const fake = { ...vault, connectAccount: async () => { throw foreignVault; } } as typeof vault;
    const r1 = await handleImport(authed("/api/vault/accounts", importBody("X")), { ...deps, getVault: () => fake });
    expect(r1.status).toBe(409);
    const noCode = Object.assign(new Error("x"), { name: "JarError" });
    const fake2 = { ...vault, connectAccount: async () => { throw noCode; } } as typeof vault;
    const r2 = await handleImport(authed("/api/vault/accounts", importBody("X")), { ...deps, getVault: () => fake2 });
    expect(r2.status).toBe(500);
  });

  it("invalid JSON text / wrong shape: generic error that does not echo the input", async () => {
    const { deps } = setup();
    for (const json of ["{oops SECRET-PASTE", "\"just a string SECRET-PASTE\"", "", "   "]) {
      const res = await handleImport(authed("/api/vault/accounts", { label: "X", json }), deps);
      expect(res.status).toBe(400);
      const body = await text(res);
      expect(JSON.parse(body).error.code).toBe("invalid_format");
      expect(body).not.toContain("SECRET-PASTE");
    }
  });

  it("validates the label", async () => {
    const { deps } = setup();
    for (const label of ["", "   ", "x".repeat(61), "bad\nlabel", 5 as unknown as string]) {
      const res = await handleImport(authed("/api/vault/accounts", { label, json: JSON.stringify(cookies) }), deps);
      expect(res.status).toBe(400);
      expect(JSON.parse(await text(res)).error.code).toBe("invalid_label");
    }
  });

  it("rejects an oversized body", async () => {
    const { deps } = setup();
    const res = await handleImport(authed("/api/vault/accounts", { label: "X", json: "a".repeat(600 * 1024) }), deps);
    expect(res.status).toBe(400);
  });

  it("a storage failure is a generic 500 with no values", async () => {
    const { deps, sessions } = setup();
    sessions.put = async () => {
      throw new Error("db exploded with SECRET-SID-VALUE");
    };
    const res = await handleImport(authed("/api/vault/accounts", importBody()), deps);
    expect(res.status).toBe(500);
    expect(await text(res)).not.toContain("SECRET-");
  });
});

describe("list, kill, revoke-all", () => {
  it("lists id, label, status, createdAt and a cookie NAME count only", async () => {
    const { deps } = setup();
    await handleImport(authed("/api/vault/accounts", importBody("A")), deps);
    const res = await handleListAccounts(get("/api/vault/accounts", { cookie: ownerCookie() }), deps);
    expect(res.status).toBe(200);
    const body = await text(res);
    expect(body).not.toMatch(/SECRET-|SID|NID|envelope|emailHash/);
    const [a] = JSON.parse(body).accounts;
    expect(Object.keys(a).sort()).toEqual(["cookieNameCount", "createdAt", "id", "label", "status"]);
    expect(a.cookieNameCount).toBe(3);
  });

  it("kill disables the account and removes the sealed session", async () => {
    const { deps, sessions, accounts } = setup();
    const id = JSON.parse(await text(await handleImport(authed("/api/vault/accounts", importBody()), deps))).account.id;
    expect(sessions.size()).toBe(1);
    const res = await handleKill(authed(`/api/vault/accounts/${id}/kill`), id, deps);
    expect(res.status).toBe(200);
    expect(sessions.size()).toBe(0);
    expect((await accounts.get(id))!.status).toBe("disabled");
    const list = JSON.parse(await text(await handleListAccounts(get("/api/vault/accounts", { cookie: ownerCookie() }), deps)));
    expect(list.accounts[0]).toMatchObject({ status: "disabled", cookieNameCount: null });
  });

  it("kill: 404 for unknown or malformed ids", async () => {
    const { deps } = setup();
    expect((await handleKill(authed("/x"), "00000000-0000-4000-8000-0000000000ff", deps)).status).toBe(404);
    expect((await handleKill(authed("/x"), "../../etc", deps)).status).toBe(404);
  });

  it("revoke-all disables every account and wipes every session", async () => {
    const { deps, sessions, accounts } = setup();
    await handleImport(authed("/api/vault/accounts", importBody("A")), deps);
    await handleImport(authed("/api/vault/accounts", importBody("B")), deps);
    const res = await handleRevokeAll(authed("/api/vault/revoke-all"), deps);
    expect(JSON.parse(await text(res))).toEqual({ ok: true, disabled: 2 });
    expect(sessions.size()).toBe(0);
    expect((await accounts.list()).every((a) => a.status === "disabled")).toBe(true);
  });
});
