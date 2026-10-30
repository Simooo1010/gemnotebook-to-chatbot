// Hashing, random values and PKCE. node:crypto only.
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export type RandomBytes = (n: number) => Buffer;
export const defaultRandom: RandomBytes = (n) => nodeRandomBytes(n);

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const randomB64u = (random: RandomBytes, n = 32) => random(n).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // Compare equal-length buffers even on mismatch so timing does not leak the length match.
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** RFC 7636 verifier: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** S256 challenge = base64url(sha256(verifier)) without padding: exactly 43 chars. */
export const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** S256 only; "plain" is never accepted. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  return safeEqual(s256(verifier), challenge);
}
