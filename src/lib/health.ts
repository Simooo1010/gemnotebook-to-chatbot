export const SERVICE_NAME = "notebooklm-connector";

/** Env var names the service needs. Only names are ever reported, never values. */
export const REQUIRED_ENV = [
  "NOTEBOOKLM_BASE_URL",
  "VAULT_ENCRYPTION_KEY",
  "VAULT_KEY_VERSION",
  "OWNER_PASSPHRASE_HASH",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "OAUTH_SIGNING_KEY",
  "PUBLIC_BASE_URL",
] as const;

export type RequiredEnvName = (typeof REQUIRED_ENV)[number];

export interface HealthReport {
  ok: true;
  service: typeof SERVICE_NAME;
  version: string;
  env: Record<RequiredEnvName, boolean>;
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
  return { ok: true, service: SERVICE_NAME, version, env: flags };
}
