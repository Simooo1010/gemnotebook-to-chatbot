import { describe, expect, it } from "vitest";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";
import { ROTATE_BODY, createRotationLimiter, keepAliveAccount, rotateCookies } from "./keepalive";
import { SYN_SID, fakeClock, res, scriptedFetch, synthJar } from "./testing";

const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), VAULT_KEY_VERSION: "1" });
const rawExport = synthJar().cookies;

describe("rotateCookies", () => {
  it("posts the literal body, merges cookies, at most once per 60 s", async () => {
    const clock = fakeClock();
    const limiter = createRotationLimiter({ now: clock.now });
    const { fetch, calls } = scriptedFetch([
      () => res(200, { setCookie: ["SIDCC=rot1; Domain=.google.com; Path=/; Secure"] }),
      () => res(200, { setCookie: ["SIDCC=rot2; Domain=.google.com; Path=/; Secure"] }),
    ]);
    const r1 = await rotateCookies({ fetch, jar: synthJar(), accountId: "a", limiter, now: clock.now });
    expect(r1.rotated).toBe(true);
    expect(calls[0]!.url).toBe("https://accounts.google.com/RotateCookies");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(ROTATE_BODY);
    expect(ROTATE_BODY).toBe('[000,"-0000000000000000000"]');
    expect(calls[0]!.init.headers).toMatchObject({ "Content-Type": "application/json", Origin: "https://accounts.google.com" });
    expect(calls[0]!.init.signal).toBeDefined();
    expect(r1.jar.cookies.find((c) => c.name === "SIDCC")!.value).toBe("rot1");
    clock.advance(59_000);
    const r2 = await rotateCookies({ fetch, jar: r1.jar, accountId: "a", limiter, now: clock.now });
    expect(r2.rotated).toBe(false);
    expect(calls).toHaveLength(1);
    clock.advance(1000);
    expect((await rotateCookies({ fetch, jar: r1.jar, accountId: "a", limiter, now: clock.now })).rotated).toBe(true);
  });
});

describe("keepAliveAccount", () => {
  function setup() {
    const accounts = new MemoryAccountRepo();
    const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
    return { accounts, vault };
  }
  it("persists the rotated jar", async () => {
    const { accounts, vault } = setup();
    const { account } = await vault.connectAccount("Synthetic", rawExport);
    const { fetch } = scriptedFetch([() => res(200, { setCookie: ["SIDCC=rot9; Domain=.google.com; Path=/; Secure"] })]);
    const out = await keepAliveAccount(vault, account.id, { fetch, accounts, limiter: createRotationLimiter() });
    expect(out).toBe("rotated");
    const jar = await vault.getJar(account.id);
    expect(jar.cookies.find((c) => c.name === "SIDCC")!.value).toBe("rot9");
    expect(jar.cookies.find((c) => c.name === "SID")!.value).toBe(SYN_SID);
  });
  it("marks needs_reauth on auth failure, without retry", async () => {
    const { accounts, vault } = setup();
    const { account } = await vault.connectAccount("Synthetic", rawExport);
    const { fetch, calls } = scriptedFetch([() => res(401)]);
    expect(await keepAliveAccount(vault, account.id, { fetch, accounts, limiter: createRotationLimiter() })).toBe("needs_reauth");
    expect(calls).toHaveLength(1);
    expect((await accounts.get(account.id))!.status).toBe("needs_reauth");
  });
  it("redirect to sign-in also means needs_reauth", async () => {
    const { accounts, vault } = setup();
    const { account } = await vault.connectAccount("Synthetic", rawExport);
    const { fetch } = scriptedFetch([() => res(302, { location: "https://accounts.google.com/ServiceLogin" }), () => res(200)]);
    expect(await keepAliveAccount(vault, account.id, { fetch, accounts, limiter: createRotationLimiter() })).toBe("needs_reauth");
  });
});
