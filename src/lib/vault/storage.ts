// Storage ports for the vault. Adapters: memory.ts (tests/dev); Supabase in Step 2b.

export type AccountStatus = "active" | "needs_reauth" | "disabled";

export interface Account {
  id: string;
  label: string;
  emailHash: string | null;
  status: AccountStatus;
  createdAt: Date;
}

export interface NewAccount {
  label: string;
  emailHash: string | null;
}

export interface AccountRepo {
  create(input: NewAccount): Promise<Account>;
  list(): Promise<Account[]>;
  get(id: string): Promise<Account | null>;
  setStatus(id: string, status: AccountStatus): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface StoredSession {
  envelope: string;
  rotatedAt: Date;
}

export interface SessionVault {
  put(accountId: string, envelope: string, rotatedAt: Date): Promise<void>;
  get(accountId: string): Promise<StoredSession | null>;
  delete(accountId: string): Promise<void>;
}
