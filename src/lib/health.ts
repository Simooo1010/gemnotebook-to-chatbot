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
] as const;

/** Owner login accepts either; reported separately so neither shows as "missing" when the other is used. */
export const OWNER_PASSPHRASE_ENV = ["OWNER_PASSPHRASE", "OWNER_PASSPHRASE_HASH"] as const;

export type RequiredEnvName = (typeof REQUIRED_ENV)[number];

export interface HealthReport {
  ok: true;
  service: typeof SERVICE_NAME;
  version: string;
  env: Record<RequiredEnvName, boolean>;
  /** True when OWNER_PASSPHRASE or OWNER_PASSPHRASE_HASH is set (names only, never values). */
  ownerPassphrase: boolean;
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
  return { ok: true, service: SERVICE_NAME, version, env: flags, ownerPassphrase: OWNER_PASSPHRASE_ENV.some(isSet) };
}
