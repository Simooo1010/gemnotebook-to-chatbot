// Key derivation from the single owner-supplied MASTER_SECRET (HKDF-SHA256, RFC 5869). Pure: node:crypto only, no logging.
// This is only a FALLBACK: an explicit VAULT_ENCRYPTION_KEY / OAUTH_SIGNING_KEY always wins (see resolveSigningSecret and loadKeyring).
// Errors name the variable only, never a value or a length of the supplied secret.
import { hkdfSync } from "node:crypto";

type Env = Record<string, string | undefined>;

export const MASTER_MIN_CHARS = 32;
export type KeyLabel = "vault" | "oauth";

// Fixed, public, app-specific salt. Changing it (or the ":v1" in info) changes every derived key and makes stored data unreadable.
const SALT = Buffer.from("notebooklm-connector/hkdf-salt/v1", "utf8");
const LABELS: readonly KeyLabel[] = ["vault", "oauth"];

/** Configuration problem. Message names the variable only. */
export class MasterSecretError extends Error {
  constructor() {
    super("MASTER_SECRET must be at least 32 characters");
    this.name = "MasterSecretError";
  }
}

/** Derives `length` (32) bytes for `label`. Throws MasterSecretError when the master is not a string of >= 32 characters. */
export function deriveKey(master: string, label: KeyLabel, length: 32): Buffer {
  if (typeof master !== "string" || master.length < MASTER_MIN_CHARS) throw new MasterSecretError();
  if (!LABELS.includes(label) || length !== 32) throw new Error("deriveKey: unsupported label or length");
  const info = Buffer.from(`notebooklm-connector:${label}:v1`, "utf8");
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), SALT, info, length));
}

/** The configured MASTER_SECRET, or undefined when unset/blank. Not validated here (deriveKey does that). */
export function masterSecret(env: Env): string | undefined {
  const v = env.MASTER_SECRET;
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * Secret used to sign the OAuth tokens, owner session, consent CSRF and media links.
 * Explicit OAUTH_SIGNING_KEY wins (returned unchanged, even if too short: the caller then fails closed).
 * Otherwise the 'oauth' key derived from MASTER_SECRET, as a 43-character base64url string.
 * Returns undefined when neither is usable (callers throw their own config error).
 */
export function resolveSigningSecret(env: Env): string | undefined {
  const explicit = env.OAUTH_SIGNING_KEY;
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;
  const master = masterSecret(env);
  if (master === undefined) return undefined;
  try {
    return deriveKey(master, "oauth", 32).toString("base64url");
  } catch {
    return undefined;
  }
}
