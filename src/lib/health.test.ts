import { describe, expect, it } from "vitest";
import { buildHealthReport, REQUIRED_ENV, SERVICE_NAME } from "./health";

describe("buildHealthReport", () => {
  it("reports ok, service and version", () => {
    const r = buildHealthReport({}, "1.2.3");
    expect(r.ok).toBe(true);
    expect(r.service).toBe(SERVICE_NAME);
    expect(r.version).toBe("1.2.3");
  });

  it("marks every required name false when env is empty", () => {
    const r = buildHealthReport({}, "x");
    expect(Object.keys(r.env).sort()).toEqual([...REQUIRED_ENV].sort());
    expect(Object.values(r.env).every((v) => v === false)).toBe(true);
  });

  it("treats blank values as unset and non-blank as set", () => {
    const r = buildHealthReport({ SUPABASE_URL: "https://a", CRON_SECRET: "   ", OAUTH_SIGNING_KEY: "" }, "x");
    expect(r.env.SUPABASE_URL).toBe(true);
    expect(r.env.CRON_SECRET).toBe(false);
    expect(r.env.OAUTH_SIGNING_KEY).toBe(false);
  });

  it("never includes values or unrelated names", () => {
    const secret = "super-secret-value-123";
    const r = buildHealthReport({ VAULT_ENCRYPTION_KEY: secret, OTHER_THING: "y" }, "x");
    const json = JSON.stringify(r);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("OTHER_THING");
    expect(r.env.VAULT_ENCRYPTION_KEY).toBe(true);
  });

  it("reports ownerPassphrase true if either passphrase name is set, as a boolean only", () => {
    expect(buildHealthReport({}, "x").ownerPassphrase).toBe(false);
    expect(buildHealthReport({ OWNER_PASSPHRASE: "p" }, "x").ownerPassphrase).toBe(true);
    expect(buildHealthReport({ OWNER_PASSPHRASE_HASH: "h" }, "x").ownerPassphrase).toBe(true);
    expect(buildHealthReport({ OWNER_PASSPHRASE: "  " }, "x").ownerPassphrase).toBe(false);
  });

  it("reports key resolvability from explicit variables or a long MASTER_SECRET, as booleans only", () => {
    const master = "m".repeat(32);
    expect(buildHealthReport({}, "x").keys).toEqual({ vault: false, signing: false });
    const viaMaster = buildHealthReport({ MASTER_SECRET: master }, "x");
    expect(viaMaster.keys).toEqual({ vault: true, signing: true });
    expect(viaMaster.env.MASTER_SECRET).toBe(true);
    expect(JSON.stringify(viaMaster)).not.toContain(master);
    expect(buildHealthReport({ MASTER_SECRET: "m".repeat(31) }, "x").keys).toEqual({ vault: false, signing: false });
    expect(buildHealthReport({ VAULT_ENCRYPTION_KEY: "k", VAULT_KEY_VERSION: "1", OAUTH_SIGNING_KEY: "s".repeat(32) }, "x").keys).toEqual({
      vault: true,
      signing: true,
    });
    expect(buildHealthReport({ VAULT_ENCRYPTION_KEY: "k", MASTER_SECRET: master }, "x").keys.vault).toBe(false);
  });
});
