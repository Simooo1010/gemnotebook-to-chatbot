// AES-256-GCM sealing of per-account secrets. Pure: no I/O, no logging.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey, masterSecret, MasterSecretError } from "./derive";

export const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Keyring {
  currentVersion: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface Envelope {
  v: number;
  kid: string;
  nonce: string;
  ct: string; // ciphertext || 16-byte GCM tag, base64
}

/** Generic failure. The message never contains key material, plaintext or the reason. */
export class VaultCryptoError extends Error {
  constructor() {
    super("vault: operation failed");
    this.name = "VaultCryptoError";
  }
}

/** Configuration problem. Message names env variables only, never values. */
export class KeyringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringConfigError";
  }
}

const VERSION_RE = /^[0-9]{1,9}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeKey(b64: unknown, label: string): Buffer {
  if (typeof b64 !== "string" || !B64_RE.test(b64.trim())) {
    throw new KeyringConfigError(`${label} must be base64`);
  }
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new KeyringConfigError(`${label} must decode to exactly 32 bytes`);
  return key;
}

/**
 * Explicit VAULT_ENCRYPTION_KEY (+ VAULT_KEY_VERSION, required) wins. Otherwise, when MASTER_SECRET is set, the vault key is
 * derived from it (version defaults to "1"). Otherwise fail closed.
 */
export function loadKeyring(env: Record<string, string | undefined>): Keyring {
  const explicit = typeof env.VAULT_ENCRYPTION_KEY === "string" && env.VAULT_ENCRYPTION_KEY.trim().length > 0;
  const master = explicit ? undefined : masterSecret(env);
  const version = env.VAULT_KEY_VERSION?.trim() || (master !== undefined ? "1" : undefined);
  if (!version || !VERSION_RE.test(version)) {
    throw new KeyringConfigError("VAULT_KEY_VERSION must be an integer string");
  }
  if (!explicit && master === undefined) throw new KeyringConfigError("VAULT_ENCRYPTION_KEY is not set");
  const keys = new Map<string, Buffer>();
  const prev = env.VAULT_PREVIOUS_KEYS?.trim();
  if (prev) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(prev);
    } catch {
      throw new KeyringConfigError("VAULT_PREVIOUS_KEYS must be a JSON object");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new KeyringConfigError("VAULT_PREVIOUS_KEYS must be a JSON object");
    }
    for (const [v, k] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VERSION_RE.test(v)) throw new KeyringConfigError("VAULT_PREVIOUS_KEYS has a non-integer version");
      keys.set(v, decodeKey(k, `VAULT_PREVIOUS_KEYS[${v}]`));
    }
  }
  if (master !== undefined) {
    try {
      keys.set(version, deriveKey(master, "vault", 32));
    } catch (e) {
      if (e instanceof MasterSecretError) throw new KeyringConfigError(e.message);
      throw new KeyringConfigError("MASTER_SECRET could not be used");
    }
  } else {
    keys.set(version, decodeKey(env.VAULT_ENCRYPTION_KEY, "VAULT_ENCRYPTION_KEY"));
  }
  return { currentVersion: version, keys };
}

const aad = (accountId: string, kid: string) => Buffer.from(`${accountId}:${kid}`, "utf8");

export function seal(keyring: Keyring, accountId: string, plaintext: string): string {
  const kid = keyring.currentVersion;
  const key = keyring.keys.get(kid);
  if (!key || key.length !== KEY_BYTES || !accountId) throw new VaultCryptoError();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(accountId, kid));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const env: Envelope = { v: ENVELOPE_VERSION, kid, nonce: nonce.toString("base64"), ct: ct.toString("base64") };
  return JSON.stringify(env);
}

function parseEnvelope(s: string): Envelope {
  let e: unknown;
  try {
    e = JSON.parse(s);
  } catch {
    throw new VaultCryptoError();
  }
  if (!e || typeof e !== "object") throw new VaultCryptoError();
  const o = e as Record<string, unknown>;
  if (
    o.v !== ENVELOPE_VERSION ||
    typeof o.kid !== "string" ||
    typeof o.nonce !== "string" ||
    typeof o.ct !== "string" ||
    !B64_RE.test(o.nonce) ||
    !B64_RE.test(o.ct)
  ) {
    throw new VaultCryptoError();
  }
  return { v: o.v, kid: o.kid, nonce: o.nonce, ct: o.ct };
}

/** Key version of an envelope (for rotation bookkeeping). Throws VaultCryptoError if malformed. */
export function envelopeKid(envelope: string): string {
  return parseEnvelope(envelope).kid;
}

export function open(keyring: Keyring, accountId: string, envelope: string): string {
  const e = parseEnvelope(envelope);
  const key = keyring.keys.get(e.kid);
  const nonce = Buffer.from(e.nonce, "base64");
  const ct = Buffer.from(e.ct, "base64");
  if (!key || key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES || ct.length < TAG_BYTES || !accountId) {
    throw new VaultCryptoError();
  }
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    d.setAAD(aad(accountId, e.kid));
    d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()]).toString("utf8");
  } catch {
    throw new VaultCryptoError();
  }
}

/** Re-seal under the current key (no-op re-encryption if already current: fresh nonce anyway). */
export function rotate(keyring: Keyring, accountId: string, envelope: string): string {
  return seal(keyring, accountId, open(keyring, accountId, envelope));
}
