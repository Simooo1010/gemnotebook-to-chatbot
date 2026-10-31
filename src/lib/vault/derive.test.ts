import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";
import { consentCsrfToken } from "@/lib/oauth/csrf";
import { deriveMediaKey } from "@/lib/notebooklm/media-link";
import { KeyringConfigError, loadKeyring, open, seal } from "./crypto";
import { MASTER_MIN_CHARS, MasterSecretError, deriveKey, resolveSigningSecret } from "./derive";

// Synthetic values, not secrets.
const MASTER = "m".repeat(40);
const OTHER = "n".repeat(40);
const K1 = Buffer.alloc(32, 1).toString("base64");
const T0 = 1_700_000_000_000;

describe("deriveKey", () => {
  it("is deterministic and 32 bytes", () => {
    const a = deriveKey(MASTER, "vault", 32);
    expect(a.length).toBe(32);
    expect(deriveKey(MASTER, "vault", 32).equals(a)).toBe(true);
  });

  it("separates labels and masters", () => {
    const v = deriveKey(MASTER, "vault", 32);
    const o = deriveKey(MASTER, "oauth", 32);
    expect(v.equals(o)).toBe(false);
    expect(deriveKey(OTHER, "vault", 32).equals(v)).toBe(false);
    expect(v.equals(Buffer.from(MASTER).subarray(0, 32))).toBe(false);
  });

  it("matches a pinned vector (changing the salt/info would orphan stored data)", () => {
    expect(deriveKey("0123456789abcdef0123456789abcdef", "vault", 32).toString("hex")).toBe(
      "1edad841ba0fcd35da90d4949d2837f4e21a8beaba0c62f1d3f5dcac92e69163",
    );
  });

  it("rejects a short or non-string master with a message naming only the variable", () => {
    const short = "s".repeat(MASTER_MIN_CHARS - 1);
    for (const bad of [short, "", undefined as unknown as string]) {
      try {
        deriveKey(bad, "vault", 32);
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(MasterSecretError);
        expect((e as Error).message).toContain("MASTER_SECRET");
        expect((e as Error).message).not.toContain(short);
      }
    }
    expect(() => deriveKey("s".repeat(MASTER_MIN_CHARS), "vault", 32)).not.toThrow();
  });
});

describe("loadKeyring with MASTER_SECRET", () => {
  it("derives the vault key, version defaults to 1, and seal/open round-trips", () => {
    const ring = loadKeyring({ MASTER_SECRET: MASTER });
    expect(ring.currentVersion).toBe("1");
    expect(ring.keys.get("1")!.equals(deriveKey(MASTER, "vault", 32))).toBe(true);
    expect(open(loadKeyring({ MASTER_SECRET: MASTER }), "a", seal(ring, "a", "x"))).toBe("x");
    expect(() => open(loadKeyring({ MASTER_SECRET: OTHER }), "a", seal(ring, "a", "x"))).toThrow();
  });

  it("honours VAULT_KEY_VERSION and previous keys in the fallback mode", () => {
    const ring = loadKeyring({ MASTER_SECRET: MASTER, VAULT_KEY_VERSION: "3", VAULT_PREVIOUS_KEYS: JSON.stringify({ "1": K1 }) });
    expect(ring.currentVersion).toBe("3");
    expect(ring.keys.get("1")!.equals(Buffer.from(K1, "base64"))).toBe(true);
  });

  it("explicit VAULT_ENCRYPTION_KEY always wins over MASTER_SECRET", () => {
    const ring = loadKeyring({ MASTER_SECRET: MASTER, VAULT_ENCRYPTION_KEY: K1, VAULT_KEY_VERSION: "2" });
    expect(ring.currentVersion).toBe("2");
    expect(ring.keys.get("2")!.equals(Buffer.from(K1, "base64"))).toBe(true);
    // The explicit path still requires its version, and a bad explicit key is not papered over by the master.
    expect(() => loadKeyring({ MASTER_SECRET: MASTER, VAULT_ENCRYPTION_KEY: K1 })).toThrow(KeyringConfigError);
    expect(() => loadKeyring({ MASTER_SECRET: MASTER, VAULT_ENCRYPTION_KEY: "%%%", VAULT_KEY_VERSION: "1" })).toThrow(KeyringConfigError);
  });

  it("fails closed on a short master, without echoing it", () => {
    const short = "q".repeat(31);
    try {
      loadKeyring({ MASTER_SECRET: short });
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(KeyringConfigError);
      expect((e as Error).message).toContain("MASTER_SECRET");
      expect((e as Error).message).not.toContain(short);
    }
  });

  it("still fails closed with neither variable, and blank values count as unset", () => {
    expect(() => loadKeyring({})).toThrow(KeyringConfigError);
    expect(() => loadKeyring({ MASTER_SECRET: "   " })).toThrow(KeyringConfigError);
  });
});

describe("resolveSigningSecret and its consumers", () => {
  it("explicit OAUTH_SIGNING_KEY wins, unchanged (even when short: callers then fail closed)", () => {
    expect(resolveSigningSecret({ OAUTH_SIGNING_KEY: "k".repeat(40), MASTER_SECRET: MASTER })).toBe("k".repeat(40));
    expect(resolveSigningSecret({ OAUTH_SIGNING_KEY: "short", MASTER_SECRET: MASTER })).toBe("short");
    expect(() => createSessionToken({ OAUTH_SIGNING_KEY: "short", MASTER_SECRET: MASTER }, T0)).toThrow();
  });

  it("falls back to the derived oauth key (distinct from the vault key), undefined if unusable", () => {
    const s = resolveSigningSecret({ MASTER_SECRET: MASTER })!;
    expect(s).toBe(deriveKey(MASTER, "oauth", 32).toString("base64url"));
    expect(s).not.toBe(deriveKey(MASTER, "vault", 32).toString("base64url"));
    expect(Buffer.byteLength(s)).toBeGreaterThanOrEqual(32);
    expect(resolveSigningSecret({ MASTER_SECRET: "short" })).toBeUndefined();
    expect(resolveSigningSecret({})).toBeUndefined();
    expect(resolveSigningSecret({ OAUTH_SIGNING_KEY: "  ", MASTER_SECRET: MASTER })).toBe(s);
  });

  it("session, csrf and media keys all work from MASTER_SECRET alone and change with it", () => {
    const env = { MASTER_SECRET: MASTER };
    const { token } = createSessionToken(env, T0);
    expect(verifySessionToken(token, env, T0)).toBe(true);
    expect(verifySessionToken(token, { MASTER_SECRET: OTHER }, T0)).toBe(false);
    expect(consentCsrfToken("t", env)).toBeTruthy();
    expect(deriveMediaKey(env).length).toBe(32);
    expect(deriveMediaKey(env).equals(deriveMediaKey({ MASTER_SECRET: OTHER }))).toBe(false);
  });

  it("fail closed and name only variables when neither is usable", () => {
    for (const env of [{}, { MASTER_SECRET: "q".repeat(31) }]) {
      expect(() => createSessionToken(env, T0)).toThrow(/OAUTH_SIGNING_KEY|MASTER_SECRET/);
      expect(consentCsrfToken("t", env)).toBeNull();
      expect(() => deriveMediaKey(env)).toThrow();
      try {
        deriveMediaKey(env);
      } catch (e) {
        expect((e as Error).message).not.toContain("q".repeat(31));
      }
    }
  });
});
