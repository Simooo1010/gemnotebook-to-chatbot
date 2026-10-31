import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MEDIA_LINK_CONTEXT,
  MediaLinkConfigError,
  clampTtlSeconds,
  deriveMediaKey,
  mediaUrl,
  signMediaToken,
  verifyMediaToken,
  type MediaClaims,
} from "./media-link";

const ENV = { OAUTH_SIGNING_KEY: "k".repeat(48) };
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const claims: MediaClaims = { accountId: "acc-1", notebookId: "00000000-0000-4000-8000-000000000001", artifactId: "art_1", kind: "audio" };
const key = deriveMediaKey(ENV);

describe("media link tokens", () => {
  it("round-trips the claims and expires at the TTL (default 15 min)", () => {
    const { token, expiresAt } = signMediaToken(key, claims, { now: () => NOW });
    expect(expiresAt).toBe(NOW + DEFAULT_TTL_SECONDS * 1000);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyMediaToken(key, token, () => NOW)).toEqual(claims);
    expect(verifyMediaToken(key, token, () => NOW + 14 * 60_000)).toEqual(claims);
    expect(verifyMediaToken(key, token, () => expiresAt)).toBeNull(); // expired exactly at exp
    expect(verifyMediaToken(key, token, () => expiresAt + 1)).toBeNull();
  });

  it("payload holds only the documented keys and no Google URL or secret", () => {
    const { token } = signMediaToken(key, claims, { now: () => NOW });
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["a", "exp", "k", "n", "r"]);
    expect(token).not.toContain("http");
  });

  it("clamps the TTL to 1..60 minutes", () => {
    expect(clampTtlSeconds(undefined)).toBe(DEFAULT_TTL_SECONDS);
    expect(clampTtlSeconds(5)).toBe(60);
    expect(clampTtlSeconds(86_400)).toBe(MAX_TTL_SECONDS);
    expect(clampTtlSeconds(Number.NaN)).toBe(DEFAULT_TTL_SECONDS);
    const long = signMediaToken(key, claims, { now: () => NOW, ttlSeconds: 10 * 3600 });
    expect(long.expiresAt).toBe(NOW + 3600_000);
  });

  it("rejects tampering with payload, signature, structure and length", () => {
    const { token } = signMediaToken(key, claims, { now: () => NOW });
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ a: "acc-2", n: claims.notebookId, r: claims.artifactId, k: "audio", exp: Math.floor(NOW / 1000) + 600 })).toString("base64url");
    expect(verifyMediaToken(key, `${forged}.${sig}`, () => NOW)).toBeNull();
    expect(verifyMediaToken(key, `${body}.${sig.slice(0, -2)}AA`, () => NOW)).toBeNull();
    expect(verifyMediaToken(key, `${body}.`, () => NOW)).toBeNull();
    expect(verifyMediaToken(key, body, () => NOW)).toBeNull();
    expect(verifyMediaToken(key, `${body}.${sig}.x`, () => NOW)).toBeNull();
    expect(verifyMediaToken(key, "", () => NOW)).toBeNull();
    expect(verifyMediaToken(key, "a".repeat(2000), () => NOW)).toBeNull();
    expect(verifyMediaToken(key, "not base64 !.zz", () => NOW)).toBeNull();
  });

  it("rejects a validly signed token with a bad shape, a wrong kind, or an excessive lifetime", () => {
    const mint = (p: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(p)).toString("base64url");
      return `${body}.${createHmac("sha256", key).update(body, "utf8").digest("base64url")}`;
    };
    const exp = Math.floor(NOW / 1000) + 600;
    const good = { a: "a", n: "n", r: "r", k: "audio", exp };
    expect(verifyMediaToken(key, mint(good), () => NOW)).not.toBeNull();
    expect(verifyMediaToken(key, mint({ ...good, k: "report" }), () => NOW)).toBeNull();
    expect(verifyMediaToken(key, mint({ ...good, a: 5 }), () => NOW)).toBeNull();
    expect(verifyMediaToken(key, mint({ ...good, exp: "soon" }), () => NOW)).toBeNull();
    expect(verifyMediaToken(key, mint({ ...good, exp: Math.floor(NOW / 1000) + 7 * 86_400 }), () => NOW)).toBeNull();
    expect(verifyMediaToken(key, mint([1, 2] as unknown as Record<string, unknown>), () => NOW)).toBeNull();
  });

  it("is context-separated: other contexts' keys and the owner-session cookie never verify as media links", () => {
    expect(MEDIA_LINK_CONTEXT).toBe("media-link");
    const other = deriveMediaKey(ENV, "owner-session");
    const oauthCtx = deriveMediaKey(ENV, "oauth-consent-csrf");
    const raw = Buffer.from(ENV.OAUTH_SIGNING_KEY);
    expect(key.equals(other)).toBe(false);
    expect(key.equals(oauthCtx)).toBe(false);
    expect(key.equals(raw)).toBe(false);
    for (const k of [other, oauthCtx, raw]) {
      const { token } = signMediaToken(k, claims, { now: () => NOW });
      expect(verifyMediaToken(key, token, () => NOW)).toBeNull();
    }
    // a different signing key does not verify either
    const { token } = signMediaToken(deriveMediaKey({ OAUTH_SIGNING_KEY: "z".repeat(48) }), claims, { now: () => NOW });
    expect(verifyMediaToken(key, token, () => NOW)).toBeNull();
    // and the reverse: a media token is not an owner session
    const media = signMediaToken(key, claims, { now: () => NOW }).token;
    expect(verifySessionToken(media, ENV, NOW)).toBe(false);
    expect(verifyMediaToken(key, createSessionToken(ENV, NOW).token, () => NOW)).toBeNull();
  });

  it("fails closed without a long enough signing key, naming only the variable", () => {
    expect(() => deriveMediaKey({})).toThrow(MediaLinkConfigError);
    expect(() => deriveMediaKey({ OAUTH_SIGNING_KEY: "short" })).toThrow(/OAUTH_SIGNING_KEY/);
    try {
      deriveMediaKey({ OAUTH_SIGNING_KEY: "short" });
    } catch (e) {
      expect((e as Error).message).not.toContain("short");
    }
  });

  it("builds the url on our own domain", () => {
    expect(mediaUrl("https://c.example.com/", "tok")).toBe("https://c.example.com/api/media/tok");
  });
});
