// In-memory adapters (tests and local dev only).
import { randomUUID } from "node:crypto";
import type { Account, AccountRepo, AccountStatus, NewAccount, SessionVault, StoredSession } from "./storage";

export class MemoryAccountRepo implements AccountRepo {
  private rows = new Map<string, Account>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: NewAccount): Promise<Account> {
    const a: Account = { id: randomUUID(), label: input.label, emailHash: input.emailHash, status: "active", createdAt: this.now() };
    this.rows.set(a.id, a);
    return { ...a };
  }
  async list(): Promise<Account[]> {
    return [...this.rows.values()].map((a) => ({ ...a }));
  }
  async get(id: string): Promise<Account | null> {
    const a = this.rows.get(id);
    return a ? { ...a } : null;
  }
  async setStatus(id: string, status: AccountStatus): Promise<void> {
    const a = this.rows.get(id);
    if (!a) throw new Error("account not found");
    a.status = status;
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class MemorySessionVault implements SessionVault {
  private rows = new Map<string, StoredSession>();
  async put(accountId: string, envelope: string, rotatedAt: Date): Promise<void> {
    this.rows.set(accountId, { envelope, rotatedAt });
  }
  async get(accountId: string): Promise<StoredSession | null> {
    const s = this.rows.get(accountId);
    return s ? { ...s } : null;
  }
  async delete(accountId: string): Promise<void> {
    this.rows.delete(accountId);
  }
  /** Test helper: number of stored sessions. */
  size(): number {
    return this.rows.size;
  }
}
