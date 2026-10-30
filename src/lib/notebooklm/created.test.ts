import { describe, expect, it } from "vitest";
import type { Db, Row } from "@/lib/vault/supabase";
import { VaultStorageError } from "@/lib/vault/supabase";
import {
  CreatedObjectsConfigError,
  MemoryCreatedObjects,
  SupabaseCreatedObjects,
  createCreatedObjectsFromEnv,
  type CreatedObjects,
} from "./created";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";

function fakeDb() {
  const rows: Row[] = [];
  const state = { fail: false, upserts: [] as { row: Row; onConflict: string }[] };
  const boom = () => {
    if (state.fail) throw new VaultStorageError();
  };
  const db: Db = {
    async insert() {
      throw new Error("unused");
    },
    async select(_t, o) {
      boom();
      const m = o.match ?? {};
      return rows.filter((r) => Object.entries(m).every(([k, v]) => r[k] === v)).slice(o.from, o.to + 1);
    },
    async update() {
      return 0;
    },
    async upsert(_t, row, onConflict) {
      boom();
      state.upserts.push({ row, onConflict });
      const same = (r: Row) => r.account_id === row.account_id && r.kind === row.kind && r.object_id === row.object_id;
      if (!rows.some(same)) rows.push({ ...row });
    },
    async delete() {
      throw new Error("never deletes");
    },
  };
  return { db, rows, state };
}

function contract(name: string, make: () => CreatedObjects) {
  describe(name, () => {
    it("records, checks and lists per account and kind; record is idempotent", async () => {
      const c = make();
      await c.record(A, "notebook", "nb1");
      await c.record(A, "notebook", "nb1");
      await c.record(A, "notebook", "nb2");
      await c.record(A, "artifact", "ar1");
      await c.record(B, "notebook", "nb9");
      expect(await c.has(A, "notebook", "nb1")).toBe(true);
      expect(await c.has(A, "notebook", "nb9")).toBe(false);
      expect(await c.has(A, "artifact", "nb1")).toBe(false);
      expect(await c.has(B, "notebook", "nb1")).toBe(false);
      expect((await c.list(A, "notebook")).sort()).toEqual(["nb1", "nb2"]);
      expect(await c.list(A, "artifact")).toEqual(["ar1"]);
      expect(await c.list(B, "artifact")).toEqual([]);
    });
  });
}

contract("memory created objects", () => new MemoryCreatedObjects());
contract("supabase created objects (fake db)", () => new SupabaseCreatedObjects(fakeDb().db));

describe("supabase created objects", () => {
  it("upserts into created_objects on the composite key; never deletes", async () => {
    const f = fakeDb();
    await new SupabaseCreatedObjects(f.db).record(A, "notebook", "nb1");
    expect(f.state.upserts).toEqual([{ row: { account_id: A, kind: "notebook", object_id: "nb1" }, onConflict: "account_id,kind,object_id" }]);
  });

  it("lists across pages", async () => {
    const f = fakeDb();
    for (let i = 0; i < 450; i++) f.rows.push({ account_id: A, kind: "notebook", object_id: `nb${i}` });
    expect(await new SupabaseCreatedObjects(f.db).list(A, "notebook")).toHaveLength(450);
  });

  it("storage errors propagate (has/list never silently return false/empty)", async () => {
    const f = fakeDb();
    f.state.fail = true;
    const c = new SupabaseCreatedObjects(f.db);
    await expect(c.has(A, "notebook", "x")).rejects.toBeInstanceOf(VaultStorageError);
    await expect(c.list(A, "notebook")).rejects.toBeInstanceOf(VaultStorageError);
    await expect(c.record(A, "notebook", "x")).rejects.toBeInstanceOf(VaultStorageError);
  });

  it("rejects a malformed row instead of guessing", async () => {
    const f = fakeDb();
    f.rows.push({ account_id: A, kind: "notebook", object_id: 5 });
    await expect(new SupabaseCreatedObjects(f.db).list(A, "notebook")).rejects.toBeInstanceOf(VaultStorageError);
  });
});

describe("createCreatedObjectsFromEnv", () => {
  it("memory outside production, fail closed in production, error on half config", () => {
    expect(createCreatedObjectsFromEnv({ NODE_ENV: "development" })).toBeInstanceOf(MemoryCreatedObjects);
    expect(() => createCreatedObjectsFromEnv({ NODE_ENV: "production" })).toThrow(CreatedObjectsConfigError);
    expect(() => createCreatedObjectsFromEnv({ NODE_ENV: "development", SUPABASE_URL: "https://x.supabase.co" })).toThrow(CreatedObjectsConfigError);
  });
  it("supabase when both are set", () => {
    const c = createCreatedObjectsFromEnv({ NODE_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(c).toBeInstanceOf(SupabaseCreatedObjects);
  });
});
