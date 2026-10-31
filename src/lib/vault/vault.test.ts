import { describe, expect, it } from "vitest";
import { loadKeyring } from "./crypto";
import { JarError } from "./jar";
import { MemoryAccountRepo, MemorySessionVault } from "./memory";
import { VaultError, createVault } from "./vault";

const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), VAULT_KEY_VERSION: "1" });
const raw = [
  { name: "SID", value: "fake-sid", domain: ".google.com", path: "/", secure: true, httpOnly: true },
  { name: "__Secure-1PSIDTS", value: "fake-ts", domain: ".google.com", path: "/", secure: true, httpOnly: true },
];

function setup() {
  const accounts = new MemoryAccountRepo();
  const sessions = new MemorySessionVault();
  return { accounts, sessions, vault: createVault({ accounts, sessions, keyring }) };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(VaultError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("vault service", () => {
  it("connects, stores ciphertext only, and returns the jar", async () => {
    const { vault, sessions } = setup();
    const { account, summary } = await vault.connectAccount("Main", raw);
    expect(summary.names).toEqual(["SID", "__Secure-1PSIDTS"]);
    const stored = await sessions.get(account.id);
    expect(stored!.envelope).not.toContain("fake-sid");
    const jar = await vault.getJar(account.id);
    expect(jar.cookies.find((c) => c.name === "SID")!.value).toBe("fake-sid");
  });

  it("does not create an account on invalid import", async () => {
    const { vault, accounts } = setup();
    await expect(vault.connectAccount("Bad", [raw[0]])).rejects.toBeInstanceOf(JarError);
    expect(await accounts.list()).toHaveLength(0);
  });

  it("refuses getJar unless active", async () => {
    const { vault, accounts } = setup();
    const { account } = await vault.connectAccount("Main", raw);
    await accounts.setStatus(account.id, "needs_reauth");
    await rejectsWith(vault.getJar(account.id), "not_active");
    await rejectsWith(vault.updateJar(account.id, { cookies: [] }), "not_active");
    await rejectsWith(vault.getJar("missing"), "not_found");
  });

  it("updateJar re-seals the new jar", async () => {
    const { vault } = setup();
    const { account } = await vault.connectAccount("Main", raw);
    const jar = await vault.getJar(account.id);
    jar.cookies[0]!.value = "fake-updated";
    await vault.updateJar(account.id, jar);
    expect((await vault.getJar(account.id)).cookies[0]!.value).toBe("fake-updated");
  });

  it("killAccount disables and makes the session unrecoverable, even if re-activated", async () => {
    const { vault, accounts, sessions } = setup();
    const { account } = await vault.connectAccount("Main", raw);
    await vault.killAccount(account.id);
    expect((await accounts.get(account.id))!.status).toBe("disabled");
    expect(await sessions.get(account.id)).toBeNull();
    await accounts.setStatus(account.id, "active");
    await rejectsWith(vault.getJar(account.id), "no_session");
  });

  it("revokeAll disables every account and wipes all sessions", async () => {
    const { vault, accounts, sessions } = setup();
    await vault.connectAccount("A", raw);
    await vault.connectAccount("B", raw);
    expect(await vault.revokeAll()).toBe(2);
    expect(sessions.size()).toBe(0);
    expect((await accounts.list()).every((a) => a.status === "disabled")).toBe(true);
  });
});
