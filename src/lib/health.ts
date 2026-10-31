import { MASTER_MIN_CHARS } from "@/lib/vault/derive";

export const SERVICE_NAME = "notebooklm-connector";

/** Env var names the service needs. Only names are ever reported, never values. */
export const REQUIRED_ENV = [
  "NOTEBOOKLM_BASE_URL",
  "VAULT_ENCRYPTION_KEY",
  "VAULT_KEY_VERSION",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "OAUTH_SIGNING_KEY",
  "PUBLIC_BASE_URL",
  "MASTER_SECRET",
] as const;

/** Owner login accepts either; reported separately so neither shows as "missing" when the other is used. */
export const OWNER_PASSPHRASE_ENV = ["OWNER_PASSPHRASE", "OWNER_PASSPHRASE_HASH"] as const;

/**
 * Names reported above are not all individually mandatory: VAULT_ENCRYPTION_KEY, VAULT_KEY_VERSION and OAUTH_SIGNING_KEY are
 * optional when MASTER_SECRET (at least 32 characters) is set. `keys` says whether each key can actually be resolved.
 */
export type RequiredEnvName = (typeof REQUIRED_ENV)[number];

export interface HealthReport {
  /** False in production when the required storage env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) is missing. */
  ok: boolean;
  service: typeof SERVICE_NAME;
  version: string;
  env: Record<RequiredEnvName, boolean>;
  /** True when OWNER_PASSPHRASE or OWNER_PASSPHRASE_HASH is set (names only, never values). */
  ownerPassphrase: boolean;
  /** Booleans only: vault key / signing key resolvable (explicit variable, or a long enough MASTER_SECRET). */
  keys: { vault: boolean; signing: boolean };
  /** Booleans only: both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (required in production; without them sign-in and OAuth fail closed). */
  storage: boolean;
}

/** Pure: builds the health report from an env-like map. A name counts as set only if non-blank. */
export function buildHealthReport(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
): HealthReport {
  const flags = {} as Record<RequiredEnvName, boolean>;
  for (const name of REQUIRED_ENV) {
    const value = env[name];
    flags[name] = typeof value === "string" && value.trim().length > 0;
  }
  const isSet = (name: string) => typeof env[name] === "string" && env[name]!.trim().length > 0;
  const masterOk = typeof env.MASTER_SECRET === "string" && env.MASTER_SECRET.length >= MASTER_MIN_CHARS;
  const keys = {
    vault: isSet("VAULT_ENCRYPTION_KEY") ? isSet("VAULT_KEY_VERSION") : masterOk,
    signing: isSet("OAUTH_SIGNING_KEY") ? env.OAUTH_SIGNING_KEY!.length >= MASTER_MIN_CHARS : masterOk,
  };
  const storage = isSet("SUPABASE_URL") && isSet("SUPABASE_SERVICE_ROLE_KEY");
  const ok = storage || env.NODE_ENV !== "production";
  return { ok, service: SERVICE_NAME, version, env: flags, ownerPassphrase: OWNER_PASSPHRASE_ENV.some(isSet), keys, storage };
}
