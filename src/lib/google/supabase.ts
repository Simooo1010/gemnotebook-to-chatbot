// Supabase adapters for the throttle's UsageCounter and the client's AuditSink (tables usage_counters, audit_log).
// Rows hold counts and metadata only: no bodies, no cookies, no tokens.
import type { Db } from "@/lib/vault/supabase";
import type { AuditRow, AuditSink } from "./client";
import type { UsageCounter, UsageKind } from "./throttle";

const USAGE = "usage_counters";

/**
 * Per account, UTC day and kind. increment() is read-then-upsert, not atomic: two serverless instances racing can
 * under-count by one. The caps are a self-imposed safety margin below Google's limits, so this is acceptable.
 */
export class SupabaseUsageCounter implements UsageCounter {
  constructor(private readonly db: Db) {}

  private async read(accountId: string, day: string, kind: UsageKind): Promise<number> {
    const rows = await this.db.select(USAGE, { match: { account_id: accountId, day, kind }, from: 0, to: 0 });
    const n = rows[0]?.count;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  }

  get(accountId: string, day: string, kind: UsageKind): Promise<number> {
    return this.read(accountId, day, kind);
  }

  async increment(accountId: string, day: string, kind: UsageKind): Promise<number> {
    const next = (await this.read(accountId, day, kind)) + 1;
    await this.db.upsert(USAGE, { account_id: accountId, day, kind, count: next }, "account_id,day,kind");
    return next;
  }
}

export class SupabaseAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}

  async write(row: AuditRow): Promise<void> {
    await this.db.insert("audit_log", {
      account_id: row.accountId,
      tool: row.tool,
      rpc_id: row.rpcId,
      outcome: row.outcome,
      at: row.at.toISOString(),
    });
  }
}

/** Dev/test sink that keeps rows in memory. */
export class MemoryAuditSink implements AuditSink {
  readonly rows: AuditRow[] = [];
  async write(row: AuditRow): Promise<void> {
    this.rows.push(row);
  }
}
