import { describe, expect, it } from "vitest";
import { VaultConfigError, createVaultFromEnv } from "./index";
import { KeyringConfigError } from "./crypto";

const key = Buffer.alloc(32, 9).toString("base64");
const base = { VAULT_ENCRYPTION_KEY: key, VAULT_KEY_VERSION: "1" };

describe("createVaultFromEnv", () => {
  it("uses in-memory adapters outside production", async () => {
    const v = createVaultFromEnv({ ...base, NODE_ENV: "development" });
    expect(await v.listAccounts()).toEqual([]);
  });

  it("fails closed in production without Supabase config", () => {
    expect(() => createVaultFromEnv({ ...base, NODE_ENV: "production" })).toThrow(VaultConfigError);
    expect(() => createVaultFromEnv({ ...base, NODE_ENV: "production", SUPABASE_URL: "  ", SUPABASE_SERVICE_ROLE_KEY: "" })).toThrow(VaultConfigError);
  });

  it("fails closed when only one Supabase variable is set (any env)", () => {
    expect(() => createVaultFromEnv({ ...base, NODE_ENV: "development", SUPABASE_URL: "https://x.supabase.co" })).toThrow(VaultConfigError);
    expect(() => createVaultFromEnv({ ...base, SUPABASE_SERVICE_ROLE_KEY: "k" })).toThrow(VaultConfigError);
  });

  it("builds Supabase adapters when both are set, even in production, and never touches the network", () => {
    const v = createVaultFromEnv({ ...base, NODE_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" });
    expect(typeof v.connectAccount).toBe("function");
  });

  it("requires a valid keyring", () => {
    expect(() => createVaultFromEnv({ NODE_ENV: "development" })).toThrow(KeyringConfigError);
  });

  it("error messages name variables only, not values", () => {
    try {
      createVaultFromEnv({ ...base, NODE_ENV: "production", SUPABASE_URL: "https://secret-host.supabase.co" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-host");
    }
  });
});
