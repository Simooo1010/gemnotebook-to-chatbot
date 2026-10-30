// Write allow-list: ids of objects this app created (SPEC §2 `created_objects`). SERVER ONLY (Supabase adapter).
import { createServiceDb, VaultStorageError, type Db } from "@/lib/vault/supabase";

export type CreatedKind = "notebook" | "artifact";

export interface CreatedObjects {
  record(accountId: string, kind: CreatedKind, objectId: string): Promise<void>;
  has(accountId: string, kind: CreatedKind, objectId: string): Promise<boolean>;
  list(accountId: string, kind: CreatedKind): Promise<string[]>;
}

export class MemoryCreatedObjects implements CreatedObjects {
  private rows = new Map<string, Set<string>>();
  private key = (a: string, k: CreatedKind) => `${a}\u0000${k}`;
  async record(accountId: string, kind: CreatedKind, objectId: string): Promise<void> {
    const k = this.key(accountId, kind);
    (this.rows.get(k) ?? this.rows.set(k, new Set()).get(k)!).add(objectId);
  }
  async has(accountId: string, kind: CreatedKind, objectId: string): Promise<boolean> {
    return this.rows.get(this.key(accountId, kind))?.has(objectId) ?? false;
  }
  async list(accountId: string, kind: CreatedKind): Promise<string[]> {
    return [...(this.rows.get(this.key(accountId, kind)) ?? [])];
  }
}

const PAGE = 200;
const TABLE = "created_objects";

export class SupabaseCreatedObjects implements CreatedObjects {
  constructor(private readonly db: Db) {}

  async record(accountId: string, kind: CreatedKind, objectId: string): Promise<void> {
    await this.db.upsert(TABLE, { account_id: accountId, kind, object_id: objectId }, "account_id,kind,object_id");
  }

  async has(accountId: string, kind: CreatedKind, objectId: string): Promise<boolean> {
    const rows = await this.db.select(TABLE, { match: { account_id: accountId, kind, object_id: objectId }, from: 0, to: 0 });
    return rows.length > 0;
  }

  async list(accountId: string, kind: CreatedKind): Promise<string[]> {
    const out: string[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await this.db.select(TABLE, {
        match: { account_id: accountId, kind },
        orderBy: ["created_at", "object_id"],
        from,
        to: from + PAGE - 1,
      });
      for (const r of rows) {
        if (typeof r.object_id !== "string") throw new VaultStorageError();
        out.push(r.object_id);
      }
      if (rows.length < PAGE) return out;
    }
  }
}

export class CreatedObjectsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatedObjectsConfigError";
  }
}

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Same rule as the vault: Supabase when configured, memory only outside production, otherwise fail closed. */
export function createCreatedObjectsFromEnv(env: Record<string, string | undefined>): CreatedObjects {
  const url = has(env.SUPABASE_URL);
  const key = has(env.SUPABASE_SERVICE_ROLE_KEY);
  if (url && key) return new SupabaseCreatedObjects(createServiceDb(env));
  if (url !== key) throw new CreatedObjectsConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  if (env.NODE_ENV === "production") {
    throw new CreatedObjectsConfigError("write allow-list storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return new MemoryCreatedObjects();
}

const g = globalThis as unknown as { __createdObjects?: CreatedObjects };

export function getCreatedObjects(): CreatedObjects {
  return (g.__createdObjects ??= createCreatedObjectsFromEnv(process.env));
}
