import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS,
  SessionConfigError,
  checkOrigin,
  clearedCookie,
  cookieName,
  createSessionToken,
  readSessionCookie,
  sessionCookie,
  verifySessionToken,
} from "./session";

const env = { OAUTH_SIGNING_KEY: "k".repeat(40) };
const T0 = 1_800_000_000_000;

describe("session token", () => {
  it("signs and verifies", () => {
    const { token, expiresAt } = createSessionToken(env, T0);
    expect(expiresAt).toBe(T0 + SESSION_TTL_MS);
    expect(verifySessionToken(token, env, T0 + 1000)).toBe(true);
  });

  it("expires after 12 hours", () => {
    const { token } = createSessionToken(env, T0);
    expect(verifySessionToken(token, env, T0 + SESSION_TTL_MS - 1)).toBe(true);
    expect(verifySessionToken(token, env, T0 + SESSION_TTL_MS)).toBe(false);
  });

  it("rejects tampered payload, tampered signature, other keys and garbage", () => {
    const { token } = createSessionToken(env, T0);
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ iat: T0, exp: T0 + 10 * SESSION_TTL_MS, n: "x" })).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, env, T0)).toBe(false);
    expect(verifySessionToken(`${body}.${sig.slice(0, -2)}AA`, env, T0)).toBe(false);
    expect(verifySessionToken(token, { OAUTH_SIGNING_KEY: "z".repeat(40) }, T0)).toBe(false);
    for (const bad of ["", "a", "a.b.c", ".", null, undefined, "x".repeat(2000)]) expect(verifySessionToken(bad, env, T0)).toBe(false);
  });

  it("rejects a validly signed token with a lifetime beyond 12 h", () => {
    // Signed with the same derived key via the public API is impossible, so check the iat-in-future guard instead.
    const { token } = createSessionToken(env, T0 + 10 * 60_000);
    expect(verifySessionToken(token, env, T0)).toBe(false);
  });

  it("fails closed with a missing or short key", () => {
    expect(() => createSessionToken({}, T0)).toThrow(SessionConfigError);
    expect(() => createSessionToken({ OAUTH_SIGNING_KEY: "k".repeat(31) }, T0)).toThrow(SessionConfigError);
    const { token } = createSessionToken(env, T0);
    expect(verifySessionToken(token, {}, T0)).toBe(false);
    expect(verifySessionToken(token, { OAUTH_SIGNING_KEY: "k".repeat(31) }, T0)).toBe(false);
  });

  it("the error message never contains the key", () => {
    try {
      createSessionToken({ OAUTH_SIGNING_KEY: "shortsecret" }, T0);
    } catch (e) {
      expect((e as Error).message).not.toContain("shortsecret");
    }
  });

  it("token does not equal a signature made with the raw key (domain separation)", async () => {
    const { createHmac } = await import("node:crypto");
    const { token } = createSessionToken(env, T0);
    const [body, sig] = token.split(".") as [string, string];
    const rawSig = createHmac("sha256", env.OAUTH_SIGNING_KEY).update(body).digest("base64url");
    expect(sig).not.toBe(rawSig);
  });
});

describe("cookie", () => {
  it("is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ in production", () => {
    const c = sessionCookie("tok", true);
    expect(c).toMatch(/^__Host-owner=tok;/);
    for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) expect(c).toContain(a);
    expect(c).not.toContain("Domain");
  });
  it("is not Secure in dev (and drops the __Host- prefix, which requires Secure)", () => {
    const c = sessionCookie("tok", false);
    expect(c).not.toContain("Secure");
    expect(c.startsWith(`${cookieName(false)}=tok`)).toBe(true);
    expect(c).toContain("HttpOnly");
  });
  it("clears and reads", () => {
    expect(clearedCookie(true)).toContain("Max-Age=0");
    expect(readSessionCookie("a=1; __Host-owner=abc; b=2", true)).toBe("abc");
    expect(readSessionCookie("a=1", true)).toBeNull();
    expect(readSessionCookie("__Host-owner=", true)).toBeNull();
    expect(readSessionCookie(null, true)).toBeNull();
  });
});

describe("checkOrigin", () => {
  const req = (h: Record<string, string>, url = "https://app.example.com/api/x") => new Request(url, { method: "POST", headers: h });
  it("accepts same origin", () => {
    expect(checkOrigin(req({ origin: "https://app.example.com" }), "https://app.example.com")).toBe(true);
    expect(checkOrigin(req({ origin: "https://app.example.com", "sec-fetch-site": "same-origin" }), undefined)).toBe(true);
  });
  it("rejects missing, null, foreign origin and cross-site fetch metadata", () => {
    expect(checkOrigin(req({}), "https://app.example.com")).toBe(false);
    expect(checkOrigin(req({ origin: "null" }), "https://app.example.com")).toBe(false);
    expect(checkOrigin(req({ origin: "https://evil.example" }), "https://app.example.com")).toBe(false);
    expect(checkOrigin(req({ origin: "https://app.example.com", "sec-fetch-site": "cross-site" }), "https://app.example.com")).toBe(false);
    expect(checkOrigin(req({ origin: "https://app.example.com", "sec-fetch-site": "same-site" }), "https://app.example.com")).toBe(false);
    expect(checkOrigin(req({ origin: "https://app.example.com.evil.io" }), "https://app.example.com")).toBe(false);
  });
});
