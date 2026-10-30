// Owner session: HMAC-signed token in an HttpOnly cookie, plus same-origin (CSRF) check.
// Pure except node:crypto; the clock is injectable.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_KEY_BYTES = 32;
const CONTEXT = "owner-session";

/** Configuration problem. Names the variable only, never a value. */
export class SessionConfigError extends Error {
  constructor() {
    super("OAUTH_SIGNING_KEY must be set to at least 32 bytes");
    this.name = "SessionConfigError";
  }
}

function derivedKey(env: Env): Buffer {
  const raw = env.OAUTH_SIGNING_KEY;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") < MIN_KEY_BYTES) throw new SessionConfigError();
  // Domain separation: the owner-session key is never the raw OAuth signing key.
  return createHmac("sha256", Buffer.from(raw, "utf8")).update(CONTEXT, "utf8").digest();
}

const b64u = (b: Buffer) => b.toString("base64url");
const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(body, "utf8").digest();

interface Payload {
  exp: number;
  iat: number;
  n: string;
}

/** Throws SessionConfigError if the key is missing or short (fail closed). */
export function createSessionToken(env: Env, nowMs: number = Date.now()): { token: string; expiresAt: number } {
  const key = derivedKey(env);
  const payload: Payload = { iat: nowMs, exp: nowMs + SESSION_TTL_MS, n: randomBytes(12).toString("base64url") };
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  return { token: `${body}.${b64u(sign(key, body))}`, expiresAt: payload.exp };
}

/** True only for an untampered, unexpired token. Missing/short key → false (never throws). */
export function verifySessionToken(token: string | null | undefined, env: Env, nowMs: number = Date.now()): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return false;
  let key: Buffer;
  try {
    key = derivedKey(env);
  } catch {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body = "", sig = ""] = parts;
  const given = Buffer.from(sig, "base64url");
  const expected = sign(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
    if (typeof p.exp !== "number" || typeof p.iat !== "number" || typeof p.n !== "string") return false;
    return p.iat <= nowMs + 60_000 && nowMs < p.exp && p.exp - p.iat <= SESSION_TTL_MS;
  } catch {
    return false;
  }
}

// ---- Cookie ----------------------------------------------------------------
// `__Host-` cookies must be Secure, so over plain-http dev the name falls back to `owner-dev`.

export const isSecureEnv = (env: Env) => env.NODE_ENV === "production";
export const cookieName = (secure: boolean) => (secure ? "__Host-owner" : "owner-dev");

export function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName(secure)}=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${cookieName(secure)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** Reads the owner cookie value from a Cookie header. */
export function readSessionCookie(cookieHeader: string | null | undefined, secure: boolean): string | null {
  if (!cookieHeader) return null;
  const name = cookieName(secure);
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function isOwnerRequest(request: Request, env: Env, nowMs: number = Date.now()): boolean {
  const token = readSessionCookie(request.headers.get("cookie"), isSecureEnv(env));
  return verifySessionToken(token, env, nowMs);
}

// ---- CSRF ------------------------------------------------------------------

const originOf = (u: string | undefined | null): string | null => {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/**
 * State-changing requests must be same-origin: an Origin header equal to our own origin
 * (PUBLIC_BASE_URL or the request URL's origin), and Sec-Fetch-Site, when sent, must be "same-origin".
 * A missing Origin is rejected (fail closed).
 */
export function checkOrigin(request: Request, publicBaseUrl?: string | null): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  const allowed = [originOf(publicBaseUrl), originOf(request.url)].filter((o): o is string => o !== null);
  return allowed.includes(origin);
}
