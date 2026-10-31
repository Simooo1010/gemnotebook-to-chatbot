// OAuth storage ports + in-memory adapters. Codes and tokens are stored ONLY as sha256 hashes.
export const SCOPE = "notebooklm";

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: Date;
  /** Hash of the registering client's IP (per-IP registration limit). Null when no IP was available. Never the IP itself. */
  ipHash?: string | null;
  /** True once the app has received a token; only such apps (and fresh registrations) count toward the cap. */
  hasToken?: boolean;
}

export interface CodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  /** Token family the exchange will create; reuse of the code revokes it. */
  familyId: string;
  expiresAt: Date;
  used: boolean;
}

export type TokenKind = "access" | "refresh";

export interface TokenRecord {
  tokenHash: string;
  kind: TokenKind;
  clientId: string;
  scope: string;
  expiresAt: Date;
  familyId: string;
  revokedAt: Date | null;
  /** Revoked BY ROTATION (revokedAt is then the rotation time). A revoked token with rotated=false marks a revoked family. */
  rotated?: boolean;
  createdAt: Date;
}

export interface ClientStore {
  /** Apps that count toward the registration cap: they hold a token, or were registered at/after `since`. */
  countLive(since: Date): Promise<number>;
  /** Registrations from this IP hash at/after `since`. */
  countRecentByIp(ipHash: string, since: Date): Promise<number>;
  /** Records that the app received a token. Best effort. */
  markHasToken(clientId: string): Promise<void>;
  insert(c: OAuthClient): Promise<void>;
  get(clientId: string): Promise<OAuthClient | null>;
  list(): Promise<OAuthClient[]>;
  /** Deletes the client and (cascade) its codes and tokens. */
  remove(clientId: string): Promise<void>;
}

export type ConsumeResult = { status: "ok"; code: CodeRecord } | { status: "reused"; code: CodeRecord } | { status: "missing" };

export interface CodeStore {
  insert(c: CodeRecord): Promise<void>;
  /** Atomically marks the code used. A second consume reports "reused". */
  consume(codeHash: string): Promise<ConsumeResult>;
}

export interface TokenStore {
  insert(t: TokenRecord): Promise<void>;
  get(tokenHash: string): Promise<TokenRecord | null>;
  /** Atomically revokes one live token; true only for the caller that revoked it (rotation claim). `rotated` marks a rotation. */
  claim(tokenHash: string, at: Date, rotated?: boolean): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  /** Inserts an already-revoked marker row so the family reads as revoked even if it had no live token at that moment. */
  tombstoneFamily(familyId: string, clientId: string, at: Date): Promise<void>;
  /** True when any token of the family was revoked other than by rotation (replay/theft, owner revoke, tombstone). */
  familyRevoked(familyId: string): Promise<boolean>;
  revokeClient(clientId: string, at: Date): Promise<void>;
  revokeAll(at: Date): Promise<void>;
}

export interface OAuthStore {
  clients: ClientStore;
  codes: CodeStore;
  tokens: TokenStore;
}

export function createMemoryStore(): OAuthStore {
  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, CodeRecord>();
  const tokens = new Map<string, TokenRecord>();
  const revokeWhere = (pred: (t: TokenRecord) => boolean, at: Date) => {
    for (const t of tokens.values()) if (t.revokedAt === null && pred(t)) t.revokedAt = at;
  };
  return {
    clients: {
      async countLive(since) {
        return [...clients.values()].filter((c) => c.hasToken || c.createdAt.getTime() >= since.getTime()).length;
      },
      async countRecentByIp(ipHash, since) {
        return [...clients.values()].filter((c) => c.ipHash === ipHash && c.createdAt.getTime() >= since.getTime()).length;
      },
      async markHasToken(id) {
        const c = clients.get(id);
        if (c) c.hasToken = true;
      },
      async insert(c) {
        clients.set(c.clientId, { ...c, redirectUris: [...c.redirectUris] });
      },
      async get(id) {
        const c = clients.get(id);
        return c ? { ...c, redirectUris: [...c.redirectUris] } : null;
      },
      async list() {
        return [...clients.values()].map((c) => ({ ...c, redirectUris: [...c.redirectUris] }));
      },
      async remove(id) {
        clients.delete(id);
        for (const [k, v] of codes) if (v.clientId === id) codes.delete(k);
        for (const [k, v] of tokens) if (v.clientId === id) tokens.delete(k);
      },
    },
    codes: {
      async insert(c) {
        codes.set(c.codeHash, { ...c });
      },
      async consume(hash) {
        const c = codes.get(hash);
        if (!c) return { status: "missing" };
        if (c.used) return { status: "reused", code: { ...c } };
        c.used = true;
        return { status: "ok", code: { ...c } };
      },
    },
    tokens: {
      async insert(t) {
        tokens.set(t.tokenHash, { ...t });
      },
      async get(hash) {
        const t = tokens.get(hash);
        return t ? { ...t } : null;
      },
      async claim(hash, at, rotated = false) {
        const t = tokens.get(hash);
        if (!t || t.revokedAt !== null) return false;
        t.revokedAt = at;
        t.rotated = rotated;
        return true;
      },
      async revokeFamily(f, at) {
        revokeWhere((t) => t.familyId === f, at);
      },
      async tombstoneFamily(f, clientId, at) {
        const hash = `tombstone_${f}_${tokens.size}`; // memory store only
        tokens.set(hash, { tokenHash: hash, kind: "access", clientId, scope: SCOPE, expiresAt: new Date(at.getTime() + 3_600_000), familyId: f, revokedAt: at, rotated: false, createdAt: at });
      },
      async familyRevoked(f) {
        for (const t of tokens.values()) if (t.familyId === f && t.revokedAt !== null && !t.rotated) return true;
        return false;
      },
      async revokeClient(id, at) {
        revokeWhere((t) => t.clientId === id, at);
      },
      async revokeAll(at) {
        revokeWhere(() => true, at);
      },
    },
  };
}
