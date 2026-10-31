// Supabase adapters for the OAuth store (SERVER ONLY), over the vault's tiny `Db` port.
// Only hashes of codes/tokens are written. Atomic claims use conditional updates (row count).
import { createHash, randomUUID } from "node:crypto";
import { VaultStorageError, type Db, type Row } from "@/lib/vault/supabase";
import { SCOPE, type ClientStore, type CodeRecord, type CodeStore, type OAuthClient, type OAuthStore, type TokenRecord, type TokenStore } from "./store";

const PAGE = 200;
const date = (v: unknown): Date => {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new VaultStorageError();
  return d;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new VaultStorageError();
  return v;
};

function toClient(r: Row): OAuthClient {
  const uris = r.redirect_uris;
  if (!Array.isArray(uris) || !uris.every((u) => typeof u === "string")) throw new VaultStorageError();
  return {
    clientId: str(r.client_id),
    redirectUris: uris as string[],
    clientName: str(r.client_name),
    createdAt: date(r.created_at),
    ipHash: typeof r.ip_hash === "string" ? r.ip_hash : null,
    hasToken: r.has_token === true,
  };
}

function toCode(r: Row): CodeRecord {
  return {
    codeHash: str(r.code_hash),
    clientId: str(r.client_id),
    redirectUri: str(r.redirect_uri),
    codeChallenge: str(r.code_challenge),
    scope: str(r.scope),
    resource: typeof r.resource === "string" ? r.resource : null,
    familyId: str(r.family_id),
    expiresAt: date(r.expires_at),
    used: r.used !== false, // unknown → treat as used (fail closed)
  };
}

function toToken(r: Row): TokenRecord {
  const kind = r.kind === "access" || r.kind === "refresh" ? r.kind : null;
  if (!kind) throw new VaultStorageError();
  return {
    tokenHash: str(r.token_hash),
    kind,
    clientId: str(r.client_id),
    scope: str(r.scope),
    expiresAt: date(r.expires_at),
    familyId: str(r.family_id),
    revokedAt: r.revoked === false ? null : r.revoked_at ? date(r.revoked_at) : new Date(0),
    rotated: r.rotated === true,
    createdAt: date(r.created_at),
  };
}

class Clients implements ClientStore {
  constructor(private readonly db: Db) {}
  async countLive(since: Date) {
    if (!this.db.count) {
      return (await this.list()).filter((c) => c.hasToken || c.createdAt.getTime() >= since.getTime()).length;
    }
    const withToken = await this.db.count("oauth_clients", { match: { has_token: true } });
    const fresh = await this.db.count("oauth_clients", { match: { has_token: false }, gte: { created_at: since.toISOString() } });
    return withToken + fresh;
  }
  async countRecentByIp(ipHash: string, since: Date) {
    if (!this.db.count) {
      return (await this.list()).filter((c) => c.ipHash === ipHash && c.createdAt.getTime() >= since.getTime()).length;
    }
    return this.db.count("oauth_clients", { match: { ip_hash: ipHash }, gte: { created_at: since.toISOString() } });
  }
  async markHasToken(id: string) {
    await this.db.update("oauth_clients", { client_id: id, has_token: false }, { has_token: true });
  }
  async insert(c: OAuthClient) {
    await this.db.insert("oauth_clients", {
      client_id: c.clientId,
      redirect_uris: c.redirectUris,
      client_name: c.clientName,
      created_at: c.createdAt.toISOString(),
      ip_hash: c.ipHash ?? null,
      has_token: c.hasToken === true,
    });
  }
  async get(id: string) {
    const rows = await this.db.select("oauth_clients", { match: { client_id: id }, from: 0, to: 0 });
    return rows[0] ? toClient(rows[0]) : null;
  }
  async list() {
    const out: OAuthClient[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await this.db.select("oauth_clients", { orderBy: ["created_at", "client_id"], from, to: from + PAGE - 1 });
      out.push(...rows.map(toClient));
      if (rows.length < PAGE) return out;
    }
  }
  async remove(id: string) {
    await this.db.delete("oauth_clients", { client_id: id }); // codes/tokens cascade
  }
}

class Codes implements CodeStore {
  constructor(private readonly db: Db) {}
  async insert(c: CodeRecord) {
    await this.db.insert("oauth_codes", {
      code_hash: c.codeHash,
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      code_challenge: c.codeChallenge,
      scope: c.scope,
      resource: c.resource,
      family_id: c.familyId,
      expires_at: c.expiresAt.toISOString(),
      used: false,
    });
  }
  async consume(hash: string) {
    const rows = await this.db.select("oauth_codes", { match: { code_hash: hash }, from: 0, to: 0 });
    if (!rows[0]) return { status: "missing" } as const;
    const code = toCode(rows[0]);
    const won = (await this.db.update("oauth_codes", { code_hash: hash, used: false }, { used: true })) === 1;
    return won ? ({ status: "ok", code: { ...code, used: true } } as const) : ({ status: "reused", code } as const);
  }
}

class Tokens implements TokenStore {
  constructor(private readonly db: Db) {}
  async insert(t: TokenRecord) {
    await this.db.insert("oauth_tokens", {
      token_hash: t.tokenHash,
      kind: t.kind,
      client_id: t.clientId,
      scope: t.scope,
      expires_at: t.expiresAt.toISOString(),
      family_id: t.familyId,
      revoked: t.revokedAt !== null,
      revoked_at: t.revokedAt?.toISOString() ?? null,
      rotated: t.rotated === true,
      created_at: t.createdAt.toISOString(),
    });
  }
  async get(hash: string) {
    const rows = await this.db.select("oauth_tokens", { match: { token_hash: hash }, from: 0, to: 0 });
    return rows[0] ? toToken(rows[0]) : null;
  }
  private revoke(match: Row, at: Date) {
    return this.db.update("oauth_tokens", { ...match, revoked: false }, { revoked: true, revoked_at: at.toISOString() });
  }
  async claim(hash: string, at: Date, rotated = false) {
    const n = await this.db.update("oauth_tokens", { token_hash: hash, revoked: false }, { revoked: true, revoked_at: at.toISOString(), rotated });
    return n === 1;
  }
  async revokeFamily(familyId: string, at: Date) {
    await this.revoke({ family_id: familyId }, at);
  }
  async tombstoneFamily(familyId: string, clientId: string, at: Date) {
    await this.insert({
      tokenHash: createHash("sha256").update(`tombstone:${randomUUID()}`).digest("hex"), // 64-hex like every stored hash; never a real token
      kind: "access",
      clientId,
      scope: SCOPE,
      expiresAt: new Date(at.getTime() + 3_600_000),
      familyId,
      revokedAt: at,
      rotated: false,
      createdAt: at,
    });
  }
  async familyRevoked(familyId: string) {
    const rows = await this.db.select("oauth_tokens", { match: { family_id: familyId, revoked: true, rotated: false }, from: 0, to: 0 });
    return rows.length > 0;
  }
  async revokeClient(clientId: string, at: Date) {
    await this.revoke({ client_id: clientId }, at);
  }
  async revokeAll(at: Date) {
    await this.revoke({}, at);
  }
}

export function createSupabaseStore(db: Db): OAuthStore {
  return { clients: new Clients(db), codes: new Codes(db), tokens: new Tokens(db) };
}
