import { describe, expect, it } from "vitest";
import { KeyringConfigError, VaultCryptoError, loadKeyring, open, rotate, seal, envelopeKid } from "./crypto";

// Synthetic test keys (not secrets).
const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");
const PLAIN = "synthetic-plaintext-FAKE-COOKIE-123";
const ring = (extra: Record<string, string> = {}) =>
  loadKeyring({ VAULT_ENCRYPTION_KEY: K2, VAULT_KEY_VERSION: "2", ...extra });

function mutate(env: string, field: "ct" | "nonce" | "kid"): string {
  const o = JSON.parse(env);
  if (field === "kid") o.kid = "99";
  else {
    const b = Buffer.from(o[field], "base64");
    b[0] = (b[0] ?? 0) ^ 1;
    o[field] = b.toString("base64");
  }
  return JSON.stringify(o);
}

function expectGeneric(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VaultCryptoError);
    const msg = String((e as Error).message) + String((e as Error).stack);
    expect(msg).not.toContain(PLAIN);
    expect(msg).not.toContain(K1);
    expect(msg).not.toContain(K2);
    return;
  }
  throw new Error("expected failure");
}

describe("crypto", () => {
  it("round-trips and produces a self-describing envelope", () => {
    const r = ring();
    const env = seal(r, "acc-1", PLAIN);
    const o = JSON.parse(env);
    expect(Object.keys(o).sort()).toEqual(["ct", "kid", "nonce", "v"]);
    expect(o.kid).toBe("2");
    expect(Buffer.from(o.nonce, "base64")).toHaveLength(12);
    expect(env).not.toContain(PLAIN);
    expect(open(r, "acc-1", env)).toBe(PLAIN);
    expect(envelopeKid(env)).toBe("2");
  });

  it("uses a unique nonce per seal", () => {
    const r = ring();
    const nonces = new Set(Array.from({ length: 200 }, () => JSON.parse(seal(r, "a", PLAIN)).nonce));
    expect(nonces.size).toBe(200);
  });

  it.each(["ct", "nonce", "kid"] as const)("fails closed when %s is tampered", (f) => {
    const r = ring();
    expectGeneric(() => open(r, "acc-1", mutate(seal(r, "acc-1", PLAIN), f)));
  });

  it("fails closed for wrong account (AAD) and garbage envelopes", () => {
    const r = ring();
    const env = seal(r, "acc-1", PLAIN);
    expectGeneric(() => open(r, "acc-2", env));
    expectGeneric(() => open(r, "acc-1", "not json"));
    expectGeneric(() => open(r, "acc-1", JSON.stringify({ v: 2, kid: "2", nonce: "AA==", ct: "AA==" })));
  });

  it("fails closed when kid is unknown in the keyring", () => {
    const old = loadKeyring({ VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "1" });
    const env = seal(old, "a", PLAIN);
    expectGeneric(() => open(ring(), "a", env));
  });

  it("opens with a previous key and rotates to the current key", () => {
    const old = loadKeyring({ VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "1" });
    const env1 = seal(old, "a", PLAIN);
    const r = ring({ VAULT_PREVIOUS_KEYS: JSON.stringify({ "1": K1 }) });
    expect(open(r, "a", env1)).toBe(PLAIN);
    const env2 = rotate(r, "a", env1);
    expect(envelopeKid(env2)).toBe("2");
    expect(open(ring(), "a", env2)).toBe(PLAIN);
  });

  it("rejects bad key sizes and bad config without echoing values", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    const long = Buffer.alloc(33, 7).toString("base64");
    for (const env of [
      { VAULT_ENCRYPTION_KEY: short, VAULT_KEY_VERSION: "1" },
      { VAULT_ENCRYPTION_KEY: long, VAULT_KEY_VERSION: "1" },
      { VAULT_ENCRYPTION_KEY: "%%%", VAULT_KEY_VERSION: "1" },
      { VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "v1" },
      { VAULT_ENCRYPTION_KEY: K1 },
      { VAULT_KEY_VERSION: "1" },
      { VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "1", VAULT_PREVIOUS_KEYS: "{bad" },
      { VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "1", VAULT_PREVIOUS_KEYS: JSON.stringify({ "0": short }) },
    ]) {
      try {
        loadKeyring(env);
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(KeyringConfigError);
        expect((e as Error).message).not.toContain(short);
        expect((e as Error).message).not.toContain(K1);
      }
    }
  });

  it("fails closed when a keyring holds a wrong-size key", () => {
    const bad = { currentVersion: "1", keys: new Map([["1", Buffer.alloc(16)]]) };
    expectGeneric(() => seal(bad, "a", PLAIN));
  });
});
