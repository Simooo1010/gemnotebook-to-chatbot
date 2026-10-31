// Vault service: ties the keyring, cookie-jar parsing and storage ports together.
import { open, seal, type Keyring } from "./crypto";
import { jarSummary, parseCookieExport, type CookieJar, type JarSummary } from "./jar";
import type { Account, AccountRepo, SessionVault } from "./storage";

export type VaultErrorCode = "not_found" | "not_active" | "no_session";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(`vault: ${code}`);
    this.name = "VaultError";
  }
}

/** Structural VaultError check that also works across module-graph copies (see isJarError). */
export function isVaultError(e: unknown): e is VaultError {
  if (e instanceof VaultError) return true;
  return e instanceof Error && e.name === "VaultError" && typeof (e as unknown as { code?: unknown }).code === "string";
}

export interface VaultDeps {
  accounts: AccountRepo;
  sessions: SessionVault;
  keyring: Keyring;
  now?: () => Date;
}

export function createVault({ accounts, sessions, keyring, now = () => new Date() }: VaultDeps) {
  async function requireActive(accountId: string): Promise<Account> {
    const a = await accounts.get(accountId);
    if (!a) throw new VaultError("not_found");
    if (a.status !== "active") throw new VaultError("not_active");
    return a;
  }

  async function store(accountId: string, jar: CookieJar): Promise<void> {
    await sessions.put(accountId, seal(keyring, accountId, JSON.stringify(jar)), now());
  }

  return {
    /** Parse + validate first (throws JarError), then create the account and store the sealed jar. */
    async connectAccount(
      label: string,
      rawJson: unknown,
      emailHash: string | null = null,
    ): Promise<{ account: Account; summary: JarSummary }> {
      const jar = parseCookieExport(rawJson);
      const account = await accounts.create({ label, emailHash });
      try {
        await store(account.id, jar);
      } catch (e) {
        await accounts.remove(account.id);
        throw e;
      }
      return { account, summary: jarSummary(jar) };
    },

    async getJar(accountId: string): Promise<CookieJar> {
      await requireActive(accountId);
      const s = await sessions.get(accountId);
      if (!s) throw new VaultError("no_session");
      return JSON.parse(open(keyring, accountId, s.envelope)) as CookieJar;
    },

    async updateJar(accountId: string, jar: CookieJar): Promise<void> {
      await requireActive(accountId);
      await store(accountId, jar);
    },

    /** Kill switch: disable AND wipe the sealed session. */
    async killAccount(accountId: string): Promise<void> {
      const a = await accounts.get(accountId);
      if (!a) throw new VaultError("not_found");
      await accounts.setStatus(accountId, "disabled");
      await sessions.delete(accountId);
    },

    async revokeAll(): Promise<number> {
      const all = await accounts.list();
      for (const a of all) {
        await accounts.setStatus(a.id, "disabled");
        await sessions.delete(a.id);
      }
      return all.length;
    },

    listAccounts: () => accounts.list(),

    /** Flags an ACTIVE account as needing a fresh import. Never re-enables a disabled account; keeps the sealed session. */
    async markNeedsReauth(accountId: string): Promise<void> {
      const a = await accounts.get(accountId);
      if (a && a.status === "active") await accounts.setStatus(accountId, "needs_reauth");
    },
  };
}

export type Vault = ReturnType<typeof createVault>;
