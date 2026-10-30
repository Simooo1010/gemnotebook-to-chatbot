import { describe, expect, it } from "vitest";
import { VaultStorageError, type Db, type Row } from "@/lib/vault/supabase";
import { MemoryAuditSink, SupabaseAuditSink, SupabaseUsageCounter } from "./supabase";

function fakeDb() {
  const tables: Record<string, Row[]> = { usage_counters: [], audit_log: [] };
  const state = { fail: false };
  const boom = () => {
    if (state.fail) throw new VaultStorageError();
  };
  const matches = (r: Row, m: Row) => Object.entries(m).every(([k, v]) => r[k] === v);
  const db: Db = {
    async insert(t, row) {
      boom();
      tables[t]!.push({ ...row });
      return { ...row };
    },
    async select(t, o) {
      boom();
      return tables[t]!.filter((r) => matches(r, o.match ?? {})).slice(o.from, o.to + 1).map((r) => ({ ...r }));
    },
    async update() {
      return 0;
    },
    async upsert(t, row, onConflict) {
      boom();
      const cols = onConflict.split(",");
      const ex = tables[t]!.find((r) => cols.every((c) => r[c] === row[c]));
      if (ex) Object.assign(ex, row);
      else tables[t]!.push({ ...row });
    },
    async delete() {},
  };
  return { db, tables, state };
}

describe("SupabaseUsageCounter", () => {
  it("counts per account, day and kind", async () => {
    const { db, tables } = fakeDb();
    const c = new SupabaseUsageCounter(db);
    expect(await c.get("a1", "2026-10-30", "audio")).toBe(0);
    expect(await c.increment("a1", "2026-10-30", "audio")).toBe(1);
    expect(await c.increment("a1", "2026-10-30", "audio")).toBe(2);
    expect(await c.increment("a1", "2026-10-30", "video")).toBe(1);
    expect(await c.increment("a1", "2026-10-31", "audio")).toBe(1);
    expect(await c.increment("a2", "2026-10-30", "audio")).toBe(1);
    expect(await c.get("a1", "2026-10-30", "audio")).toBe(2);
    expect(tables.usage_counters).toHaveLength(4);
    expect(tables.usage_counters![0]).toEqual({ account_id: "a1", day: "2026-10-30", kind: "audio", count: 2 });
  });

  it("treats a malformed count as zero and surfaces storage failures", async () => {
    const { db, tables, state } = fakeDb();
    tables.usage_counters!.push({ account_id: "a1", day: "d", kind: "chat", count: "x" });
    const c = new SupabaseUsageCounter(db);
    expect(await c.get("a1", "d", "chat")).toBe(0);
    state.fail = true;
    await expect(c.increment("a1", "d", "chat")).rejects.toBeInstanceOf(VaultStorageError);
  });
});

describe("audit sinks", () => {
  const row = { accountId: "a1", tool: "notebooks_list", rpcId: "wXbhsf", outcome: "ok", at: new Date(Date.UTC(2026, 9, 30, 12)) };

  it("writes exactly the metadata columns", async () => {
    const { db, tables } = fakeDb();
    await new SupabaseAuditSink(db).write(row);
    expect(tables.audit_log).toEqual([
      { account_id: "a1", tool: "notebooks_list", rpc_id: "wXbhsf", outcome: "ok", at: "2026-10-30T12:00:00.000Z" },
    ]);
  });

  it("rejects when storage fails (the Google client swallows this)", async () => {
    const { db, state } = fakeDb();
    state.fail = true;
    await expect(new SupabaseAuditSink(db).write(row)).rejects.toBeInstanceOf(VaultStorageError);
  });

  it("memory sink keeps rows", async () => {
    const m = new MemoryAuditSink();
    await m.write(row);
    expect(m.rows).toEqual([row]);
  });
});
