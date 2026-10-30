import { describe, expect, it } from "vitest";
import { createLoginLimiter, hashPassphrase, verifyOwnerPassphrase } from "./passphrase";

const PASS = "synthetic test passphrase";
const fast = { N: 1024, r: 8, p: 1 };

describe("verifyOwnerPassphrase", () => {
  it("verifies a scrypt hash and rejects wrong input", () => {
    const h = hashPassphrase(PASS, fast);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain(PASS);
    expect(verifyOwnerPassphrase(PASS, { OWNER_PASSPHRASE_HASH: h })).toBe(true);
    expect(verifyOwnerPassphrase(PASS + "x", { OWNER_PASSPHRASE_HASH: h })).toBe(false);
  });

  it("hash takes precedence over plain", () => {
    const h = hashPassphrase(PASS, fast);
    expect(verifyOwnerPassphrase("other", { OWNER_PASSPHRASE_HASH: h, OWNER_PASSPHRASE: "other" })).toBe(false);
  });

  it("rejects malformed hashes", () => {
    for (const bad of ["scrypt$abc", "bcrypt$1$2$3$AAAA$BBBB", "scrypt$1000$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA=="]) {
      expect(verifyOwnerPassphrase(PASS, { OWNER_PASSPHRASE_HASH: bad })).toBe(false);
    }
  });

  it("falls back to plain comparison", () => {
    expect(verifyOwnerPassphrase(PASS, { OWNER_PASSPHRASE: PASS })).toBe(true);
    expect(verifyOwnerPassphrase("nope", { OWNER_PASSPHRASE: PASS })).toBe(false);
  });

  it("fails closed when nothing is configured or input is invalid", () => {
    expect(verifyOwnerPassphrase(PASS, {})).toBe(false);
    expect(verifyOwnerPassphrase("", { OWNER_PASSPHRASE: "" })).toBe(false);
    expect(verifyOwnerPassphrase(undefined, { OWNER_PASSPHRASE: PASS })).toBe(false);
    expect(verifyOwnerPassphrase("x".repeat(2000), { OWNER_PASSPHRASE: "x".repeat(2000) })).toBe(false);
  });
});

describe("createLoginLimiter", () => {
  it("locks out after 5 failures in 15 min and unlocks later", () => {
    let t = 0;
    const l = createLoginLimiter({ now: () => t });
    for (let i = 0; i < 4; i++) expect(l.recordFailure("ip").allowed).toBe(true);
    expect(l.recordFailure("ip").allowed).toBe(false);
    expect(l.check("ip").retryAfterMs).toBe(15 * 60_000);
    expect(l.check("other").allowed).toBe(true);
    t += 15 * 60_000;
    expect(l.check("ip").allowed).toBe(true);
  });

  it("forgets failures outside the window and resets on success", () => {
    let t = 0;
    const l = createLoginLimiter({ now: () => t });
    for (let i = 0; i < 4; i++) l.recordFailure("k");
    t += 15 * 60_000 + 1;
    expect(l.recordFailure("k").allowed).toBe(true);
    for (let i = 0; i < 3; i++) l.recordFailure("k");
    l.recordSuccess("k");
    expect(l.recordFailure("k").allowed).toBe(true);
  });
});
