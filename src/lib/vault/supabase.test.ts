import { describe, expect, it } from "vitest";
import { VaultStorageError, SupabaseAccountRepo, SupabaseSessionVault, dbFromSupabase, type Db, type Row, type SelectOptions } from "./supabase";

/** In-memory fake of the Db port with failure injection and a call log. */
function fakeDb() {
  const tables: Record<string, Row[]> = { accounts: [], sessions: [] };
  const state = { fail: false, selects: [] as SelectOptions[], n: 0 };
  const matches = (r: Row, m: Row) => Object.entries(m).every(([k, v]) => r[k] === v);
  const boom = () => {
    if (state.fail) throw new VaultStorageError();
  };
  const db: Db = {
    async insert(t, row) {
      boom();
      const r = { id: `00000000-0000-4000-8000-${String(++state.n).padStart(12, "0")}`, created_at: new Date(1_700_000_000_000 + state.n * 1000).toISOString(), ...row };
      tables[t]!.push(r);
      return { ...r };
    },
    async select(t, o) {
      boom();
      state.selects.push(o);
      return tables[t]!.filter((r) => matches(r, o.match ?? {})).slice(o.from, o.to + 1).map((r) => ({ ...r }));
    },
    async update(t, m, p) {
      boom();
      const rows = tables[t]!.filter((r) => matches(r, m));
      rows.forEach((r) => Object.assign(r, p));
      return rows.length;
    },
    async upsert(t, row, key) {
      boom();
      const ex = tables[t]!.find((r) => r[key] === row[key]);
      if (ex) Object.assign(ex, row);
      else tables[t]!.push({ ...row });
    },
    async delete(t, m) {
      boom();
      tables[t] = tables[t]!.filter((r) => !matches(r, m));
    },
  };
  return { db, tables, state };
}

describe("SupabaseAccountRepo", () => {
  it("creates, gets, lists, sets status and removes", async () => {
    const { db, tables } = fakeDb();
    const repo = new SupabaseAccountRepo(db);
    const a = await repo.create({ label: "Main", emailHash: null });
    expect(a).toMatchObject({ label: "Main", status: "active", emailHash: null });
    expect(a.createdAt).toBeInstanceOf(Date);
    expect(await repo.get(a.id)).toMatchObject({ id: a.id });
    expect(await repo.get("nope")).toBeNull();
    await repo.setStatus(a.id, "needs_reauth");
    expect((await repo.get(a.id))!.status).toBe("needs_reauth");
    expect(await repo.list()).toHaveLength(1);
    await repo.remove(a.id);
    expect(tables.accounts).toHaveLength(0);
  });

  it("setStatus on a missing account fails", async () => {
    await expect(new SupabaseAccountRepo(fakeDb().db).setStatus("x", "disabled")).rejects.toBeInstanceOf(VaultStorageError);
  });

  it("paginates list in pages", async () => {
    const { db, state } = fakeDb();
    const repo = new SupabaseAccountRepo(db);
    for (let i = 0; i < 205; i++) await repo.create({ label: `a${i}`, emailHash: null });
    expect(await repo.list()).toHaveLength(205);
    expect(state.selects.map((s) => [s.from, s.to])).toEqual([[0, 199], [200, 399]]);
  });

  it("treats an unknown stored status as disabled (fail closed)", async () => {
    const { db, tables } = fakeDb();
    const repo = new SupabaseAccountRepo(db);
    const a = await repo.create({ label: "x", emailHash: null });
    tables.accounts![0]!.status = "weird";
    expect((await repo.get(a.id))!.status).toBe("disabled");
  });

  it("storage errors are generic and leak nothing", async () => {
    const f = fakeDb();
    const repo = new SupabaseAccountRepo(f.db);
    f.state.fail = true;
    const e = await repo.create({ label: "SECRET-LABEL", emailHash: "h" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VaultStorageError);
    expect((e as Error).message).toBe("vault: storage operation failed");
    expect(JSON.stringify(e)).not.toContain("SECRET-LABEL");
  });
});

describe("SupabaseSessionVault", () => {
  it("puts (upsert), gets, replaces and deletes", async () => {
    const { db, tables } = fakeDb();
    const v = new SupabaseSessionVault(db);
    const t = new Date("2026-10-30T10:00:00Z");
    await v.put("acc", "env1", t);
    await v.put("acc", "env2", t);
    expect(tables.sessions).toHaveLength(1);
    expect(await v.get("acc")).toEqual({ envelope: "env2", rotatedAt: t });
    expect(await v.get("other")).toBeNull();
    await v.delete("acc");
    expect(await v.get("acc")).toBeNull();
  });

  it("errors do not carry the envelope", async () => {
    const f = fakeDb();
    f.state.fail = true;
    const e = await new SupabaseSessionVault(f.db).put("a", "ENVELOPE-XYZ", new Date()).catch((x: unknown) => x);
    expect((e as Error).message).not.toContain("ENVELOPE-XYZ");
  });
});

describe("dbFromSupabase", () => {
  /** Chainable thenable standing in for the PostgREST builder. */
  function builder(result: { data: unknown; error: unknown }, log: string[]) {
    const b: Record<string, unknown> = {};
    for (const m of ["insert", "select", "update", "upsert", "delete", "eq", "order", "range", "single"]) {
      b[m] = (...a: unknown[]) => (log.push(`${m}:${JSON.stringify(a)}`), b);
    }
    b.then = (res: (v: unknown) => unknown) => res(result);
    return b;
  }

  it("maps calls and replaces provider errors with a generic one", async () => {
    const log: string[] = [];
    const ok = dbFromSupabase({ from: () => builder({ data: [{ id: 1 }], error: null }, log) } as never);
    expect(await ok.select("accounts", { match: { id: "a" }, orderBy: ["created_at"], from: 0, to: 9 })).toEqual([{ id: 1 }]);
    expect(log).toContain('eq:["id","a"]');
    expect(log).toContain("range:[0,9]");
    expect(await ok.update("accounts", { id: "a" }, { status: "disabled" })).toBe(1);

    const bad = dbFromSupabase({ from: () => builder({ data: null, error: { message: "relation secret_table does not exist" } }, []) } as never);
    const e = await bad.insert("accounts", { label: "x" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VaultStorageError);
    expect((e as Error).message).not.toContain("secret_table");
    await expect(bad.delete("accounts", { id: "a" })).rejects.toBeInstanceOf(VaultStorageError);
  });
});
