import { describe, expect, it } from "vitest";
import type { Db, Row } from "@/lib/vault/supabase";
import { createSupabaseStore } from "./supabase";

function fakeDb() {
  const tables: Record<string, Row[]> = { oauth_clients: [], oauth_codes: [], oauth_tokens: [] };
  const matches = (r: Row, m: Row) => Object.entries(m).every(([k, v]) => r[k] === v);
  const db: Db = {
    async insert(t, row) {
      tables[t]!.push({ ...row });
      return { ...row };
    },
    async select(t, o) {
      return tables[t]!.filter((r) => matches(r, o.match ?? {})).slice(o.from, o.to + 1).map((r) => ({ ...r }));
    },
    async update(t, m, p) {
      const rows = tables[t]!.filter((r) => matches(r, m));
      rows.forEach((r) => Object.assign(r, p));
      return rows.length;
    },
    async upsert() {},
    async delete(t, m) {
      tables[t] = tables[t]!.filter((r) => !matches(r, m));
    },
  };
  return { db, tables };
}

describe("Supabase OAuth store", () => {
  it("codes are consumed once", async () => {
    const { db } = fakeDb();
    const s = createSupabaseStore(db);
    await s.codes.insert({ codeHash: "h", clientId: "c", redirectUri: "https://a/cb", codeChallenge: "x", scope: "notebooklm", resource: null, familyId: "f", expiresAt: new Date(1e12), used: false });
    expect((await s.codes.consume("h")).status).toBe("ok");
    expect((await s.codes.consume("h")).status).toBe("reused");
    expect((await s.codes.consume("nope")).status).toBe("missing");
  });
  it("tokens: claim once, revoke family, client list/remove", async () => {
    const { db, tables } = fakeDb();
    const s = createSupabaseStore(db);
    await s.clients.insert({ clientId: "c", redirectUris: ["https://a/cb"], clientName: "A", createdAt: new Date(1e12) });
    const base = { kind: "refresh" as const, clientId: "c", scope: "notebooklm", expiresAt: new Date(2e12), familyId: "f", revokedAt: null, createdAt: new Date(1e12) };
    await s.tokens.insert({ ...base, tokenHash: "t1" });
    await s.tokens.insert({ ...base, tokenHash: "t2" });
    expect(await s.tokens.claim("t1", new Date(1e12))).toBe(true);
    expect(await s.tokens.claim("t1", new Date(1e12))).toBe(false);
    expect((await s.tokens.get("t1"))?.revokedAt).not.toBeNull();
    await s.tokens.revokeFamily("f", new Date(1e12));
    expect((await s.tokens.get("t2"))?.revokedAt).not.toBeNull();
    expect(await s.clients.count()).toBe(1);
    expect((await s.clients.get("c"))?.redirectUris).toEqual(["https://a/cb"]);
    await s.clients.remove("c");
    expect(tables.oauth_clients).toHaveLength(0);
  });
});
