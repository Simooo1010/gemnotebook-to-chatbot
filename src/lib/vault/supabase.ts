// Supabase adapters for the vault ports. SERVER ONLY: holds the service-role client.
// The client sits behind the tiny `Db` interface so tests inject a fake.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Account, AccountRepo, AccountStatus, NewAccount, SessionVault, StoredSession } from "./storage";

if (typeof window !== "undefined") {
  throw new Error("vault/supabase must never be imported into client code");
}

export type Row = Record<string, unknown>;

export interface SelectOptions {
  match?: Row;
  orderBy?: string[];
  from: number;
  to: number; // inclusive
}

/** Minimal table access used by the adapters. Every method rejects on any storage error. */
export interface Db {
  insert(table: string, row: Row): Promise<Row>;
  select(table: string, opts: SelectOptions): Promise<Row[]>;
  /** Returns the number of rows changed. */
  update(table: string, match: Row, patch: Row): Promise<number>;
  upsert(table: string, row: Row, onConflict: string): Promise<void>;
  delete(table: string, match: Row): Promise<void>;
  /** Optional: delete rows whose `column` is strictly before `isoTime` (and equal to `match`, if given). Used for pruning. */
  deleteBefore?(table: string, column: string, isoTime: string, match?: Row): Promise<void>;
  /** Optional: number of rows equal to `match` whose `gte` columns are >= the given values (exact count, no rows transferred). */
  count?(table: string, opts: { match?: Row; gte?: Row }): Promise<number>;
  /** Optional: calls a database function without arguments (service role only) and returns its JSON result. */
  rpc?(fn: string): Promise<unknown>;
}

/** Generic on purpose: the underlying error (which may echo queries or values) is never propagated. */
export class VaultStorageError extends Error {
  constructor() {
    super("vault: storage operation failed");
    this.name = "VaultStorageError";
  }
}

/** Wraps a service-role Supabase client as a `Db`. Errors are replaced by VaultStorageError. */
export function dbFromSupabase(sb: Pick<SupabaseClient, "from"> & Partial<Pick<SupabaseClient, "rpc">>): Db {
  const fail = (): never => {
    throw new VaultStorageError();
  };
  return {
    async insert(table, row) {
      const { data, error } = await sb.from(table).insert(row).select().single();
      if (error || !data) return fail();
      return data as Row;
    },
    async select(table, { match = {}, orderBy = [], from, to }) {
      let q = sb.from(table).select("*");
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
      for (const col of orderBy) q = q.order(col, { ascending: true });
      const { data, error } = await q.range(from, to);
      if (error || !data) return fail();
      return data as Row[];
    },
    async update(table, match, patch) {
      let q = sb.from(table).update(patch);
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
      const { data, error } = await q.select();
      if (error || !data) return fail();
      return data.length;
    },
    async upsert(table, row, onConflict) {
      const { error } = await sb.from(table).upsert(row, { onConflict });
      if (error) fail();
    },
    async delete(table, match) {
      let q = sb.from(table).delete();
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
      const { error } = await q;
      if (error) fail();
    },
    async deleteBefore(table, column, isoTime, match = {}) {
      let q = sb.from(table).delete().lt(column, isoTime);
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
      const { error } = await q;
      if (error) fail();
    },
    async count(table, { match = {}, gte = {} }) {
      let q = sb.from(table).select("*", { count: "exact" });
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
      for (const [k, v] of Object.entries(gte)) q = q.gte(k, v as string);
      const { count, error } = await q.range(0, 0);
      if (error || typeof count !== "number") return fail();
      return count;
    },
    async rpc(fn) {
      if (!sb.rpc) return fail();
      const { data, error } = await sb.rpc(fn);
      if (error) return fail();
      return data;
    },
  };
}

/** Service-role client from env. Throws a generic config error naming only variables. */
export function createServiceDb(env: Record<string, string | undefined>): Db {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return dbFromSupabase(sb);
}

const STATUSES: readonly AccountStatus[] = ["active", "needs_reauth", "disabled"];
const PAGE = 200;

function toAccount(r: Row): Account {
  const status = STATUSES.find((s) => s === r.status) ?? "disabled"; // unknown → fail closed
  const createdAt = new Date(String(r.created_at));
  if (typeof r.id !== "string" || typeof r.label !== "string" || Number.isNaN(createdAt.getTime())) {
    throw new VaultStorageError();
  }
  return {
    id: r.id,
    label: r.label,
    emailHash: typeof r.email_hash === "string" ? r.email_hash : null,
    status,
    createdAt,
  };
}

export class SupabaseAccountRepo implements AccountRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewAccount): Promise<Account> {
    return toAccount(await this.db.insert("accounts", { label: input.label, email_hash: input.emailHash, status: "active" }));
  }

  async list(): Promise<Account[]> {
    const out: Account[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await this.db.select("accounts", { orderBy: ["created_at", "id"], from, to: from + PAGE - 1 });
      out.push(...rows.map(toAccount));
      if (rows.length < PAGE) return out;
    }
  }

  async get(id: string): Promise<Account | null> {
    const rows = await this.db.select("accounts", { match: { id }, from: 0, to: 0 });
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async setStatus(id: string, status: AccountStatus): Promise<void> {
    if ((await this.db.update("accounts", { id }, { status })) === 0) throw new VaultStorageError();
  }

  async remove(id: string): Promise<void> {
    await this.db.delete("accounts", { id });
  }
}

export class SupabaseSessionVault implements SessionVault {
  constructor(private readonly db: Db) {}

  async put(accountId: string, envelope: string, rotatedAt: Date): Promise<void> {
    await this.db.upsert("sessions", { account_id: accountId, envelope, rotated_at: rotatedAt.toISOString() }, "account_id");
  }

  async get(accountId: string): Promise<StoredSession | null> {
    const rows = await this.db.select("sessions", { match: { account_id: accountId }, from: 0, to: 0 });
    const r = rows[0];
    if (!r) return null;
    const rotatedAt = new Date(String(r.rotated_at));
    if (typeof r.envelope !== "string" || Number.isNaN(rotatedAt.getTime())) throw new VaultStorageError();
    return { envelope: r.envelope, rotatedAt };
  }

  async delete(accountId: string): Promise<void> {
    await this.db.delete("sessions", { account_id: accountId });
  }
}
