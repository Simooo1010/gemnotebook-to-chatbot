// Vault factory. Supabase when configured; in-memory only outside production; otherwise fail closed.
import { loadKeyring } from "./crypto";
import { MemoryAccountRepo, MemorySessionVault } from "./memory";
import { createServiceDb, SupabaseAccountRepo, SupabaseSessionVault } from "./supabase";
import { createVault, type Vault } from "./vault";

type Env = Record<string, string | undefined>;

export class VaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConfigError";
  }
}

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Pure factory (no caching). Throws VaultConfigError/KeyringConfigError; messages name variables only. */
export function createVaultFromEnv(env: Env): Vault {
  const keyring = loadKeyring(env);
  const url = has(env.SUPABASE_URL);
  const key = has(env.SUPABASE_SERVICE_ROLE_KEY);

  if (url && key) {
    const db = createServiceDb(env);
    return createVault({ accounts: new SupabaseAccountRepo(db), sessions: new SupabaseSessionVault(db), keyring });
  }
  if (url !== key) {
    throw new VaultConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  }
  if (env.NODE_ENV === "production") {
    throw new VaultConfigError("vault storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return createVault({ accounts: new MemoryAccountRepo(), sessions: new MemorySessionVault(), keyring });
}

const g = globalThis as unknown as { __vault?: Vault };

/** Process-wide vault (survives dev hot reloads so the in-memory dev store is not wiped). */
export function getVault(): Vault {
  return (g.__vault ??= createVaultFromEnv(process.env));
}
