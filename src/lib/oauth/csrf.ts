// Consent CSRF token: HMAC over the owner session token, with a key derived from OAUTH_SIGNING_KEY.
import { createHmac } from "node:crypto";
import { MIN_KEY_BYTES } from "@/lib/auth/session";
import { safeEqual } from "./crypto";

type Env = Record<string, string | undefined>;

function key(env: Env): Buffer | null {
  const raw = env.OAUTH_SIGNING_KEY;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") < MIN_KEY_BYTES) return null;
  return createHmac("sha256", Buffer.from(raw, "utf8")).update("oauth-consent-csrf", "utf8").digest();
}

/** Null when the signing key is missing (the caller fails closed). */
export function consentCsrfToken(sessionToken: string, env: Env): string | null {
  const k = key(env);
  return k ? createHmac("sha256", k).update(sessionToken, "utf8").digest("base64url") : null;
}

export function verifyConsentCsrf(given: unknown, sessionToken: string | null, env: Env): boolean {
  if (typeof given !== "string" || !sessionToken) return false;
  const expected = consentCsrfToken(sessionToken, env);
  return expected !== null && safeEqual(given, expected);
}
