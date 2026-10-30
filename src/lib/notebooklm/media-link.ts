// Signed, short-lived download links (SPEC §3 Downloads). Pure: node:crypto only, the clock is injected.
// Token = base64url(JSON {a,n,r,k,exp}) + "." + base64url(HMAC-SHA256). The key is derived from OAUTH_SIGNING_KEY with its own
// context label, so an owner-session cookie or consent token can never be replayed as a media link (and vice versa).
// The token holds ids only: never a Google URL, cookie or secret. It is a bearer capability: anyone holding the link can
// download that one file until it expires.
import { createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export const MEDIA_LINK_CONTEXT = "media-link";
export const MIN_KEY_BYTES = 32;
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TOKEN_CHARS = 1024;

export type MediaKind = "audio" | "video";

export interface MediaClaims {
  accountId: string;
  notebookId: string;
  artifactId: string;
  kind: MediaKind;
}

/** Configuration problem. Names the variable only, never a value. */
export class MediaLinkConfigError extends Error {
  constructor() {
    super("OAUTH_SIGNING_KEY must be set to at least 32 bytes");
    this.name = "MediaLinkConfigError";
  }
}

/** Key for media links. Throws MediaLinkConfigError when the signing key is missing or short (fail closed). */
export function deriveMediaKey(env: Env, context: string = MEDIA_LINK_CONTEXT): Buffer {
  const raw = env.OAUTH_SIGNING_KEY;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") < MIN_KEY_BYTES) throw new MediaLinkConfigError();
  return createHmac("sha256", Buffer.from(raw, "utf8")).update(context, "utf8").digest();
}

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body, "utf8").digest();

export function clampTtlSeconds(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)));
}

export interface SignedMediaToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function signMediaToken(key: Buffer, claims: MediaClaims, opts: { now: () => number; ttlSeconds?: number }): SignedMediaToken {
  const exp = Math.floor(opts.now() / 1000) + clampTtlSeconds(opts.ttlSeconds);
  const body = Buffer.from(
    JSON.stringify({ a: claims.accountId, n: claims.notebookId, r: claims.artifactId, k: claims.kind, exp }),
    "utf8",
  ).toString("base64url");
  return { token: `${body}.${mac(key, body).toString("base64url")}`, expiresAt: exp * 1000 };
}

const B64U = /^[A-Za-z0-9_-]+$/;

/** Returns the claims, or null for anything malformed, tampered, expired or signed with another key/context. */
export function verifyMediaToken(key: Buffer, token: string, now: () => number): MediaClaims | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!B64U.test(body) || !B64U.test(sig)) return null;
  const given = Buffer.from(sig, "base64url");
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (typeof o.a !== "string" || typeof o.n !== "string" || typeof o.r !== "string") return null;
  if (o.k !== "audio" && o.k !== "video") return null;
  if (typeof o.exp !== "number" || !Number.isFinite(o.exp)) return null;
  const nowSec = now() / 1000;
  if (o.exp <= nowSec) return null;
  if (o.exp > nowSec + MAX_TTL_SECONDS + 5) return null; // never honour a token minted with a longer life than allowed
  return { accountId: o.a, notebookId: o.n, artifactId: o.r, kind: o.k };
}

export const MEDIA_CONTENT_TYPE: Record<MediaKind, string> = { audio: "audio/mp4", video: "video/mp4" };
export const MEDIA_FILENAME: Record<MediaKind, string> = { audio: "overview.m4a", video: "overview.mp4" };

export const mediaUrl = (base: string, token: string) => `${base.replace(/\/+$/, "")}/api/media/${token}`;
