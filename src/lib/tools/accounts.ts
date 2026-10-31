// Account resolution for tools: `account` (id or label) is optional when exactly one ACTIVE account exists.
import type { Account } from "@/lib/vault/storage";

export type AccountResolutionKind = "no_accounts" | "no_active_account" | "account_required" | "unknown_account" | "account_unavailable";

/** Messages are plain language for Claude and contain account ids/labels only. */
export class AccountResolutionError extends Error {
  constructor(
    readonly kind: AccountResolutionKind,
    message: string,
  ) {
    super(message);
    this.name = "AccountResolutionError";
  }
}

const describe = (a: Account) => `${a.label} (id ${a.id})`;

export function resolveAccount(accounts: Account[], requested?: string | null): Account {
  const want = requested?.trim();
  if (want) {
    const byId = accounts.find((a) => a.id === want);
    const byLabel = byId ? [] : accounts.filter((a) => a.label.toLowerCase() === want.toLowerCase());
    if (byLabel.length > 1) {
      throw new AccountResolutionError("unknown_account", `More than one account is labelled "${want}". Use the account id from accounts_list.`);
    }
    const a = byId ?? byLabel[0];
    if (!a) throw new AccountResolutionError("unknown_account", `No account matches "${want}". Call accounts_list to see the available accounts.`);
    if (a.status === "disabled") {
      throw new AccountResolutionError("account_unavailable", `Account ${describe(a)} is disabled by the owner. Use another account, or ask the owner to import it again on the vault page.`);
    }
    if (a.status === "needs_reauth") {
      throw new AccountResolutionError("account_unavailable", `Account ${describe(a)} needs its Google session re-imported. Ask the owner to re-import this account on the vault page, then try again.`);
    }
    return a;
  }
  if (accounts.length === 0) {
    throw new AccountResolutionError("no_accounts", "No Google account is connected yet. Ask the owner to import one on the vault page.");
  }
  const active = accounts.filter((a) => a.status === "active");
  if (active.length === 1) return active[0]!;
  if (active.length === 0) {
    throw new AccountResolutionError("no_active_account", "No account is usable right now (all are disabled or need re-import). Ask the owner to re-import an account on the vault page.");
  }
  throw new AccountResolutionError(
    "account_required",
    `Several accounts are active, so the "account" argument is required. Choose one: ${active.map(describe).join("; ")}.`,
  );
}
