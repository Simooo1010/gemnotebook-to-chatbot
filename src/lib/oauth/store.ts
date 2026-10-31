// OAuth storage ports + in-memory adapters. Codes and tokens are stored ONLY as sha256 hashes.
export const SCOPE = "notebooklm";

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: Date;
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
  createdAt: Date;
}

export interface ClientStore {
  count(): Promise<number>;
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
  /** Atomically revokes one live token; true only for the caller that revoked it (rotation claim). */
  claim(tokenHash: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
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
      async count() {
        return clients.size;
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
      async claim(hash, at) {
        const t = tokens.get(hash);
        if (!t || t.revokedAt !== null) return false;
        t.revokedAt = at;
        return true;
      },
      async revokeFamily(f, at) {
        revokeWhere((t) => t.familyId === f, at);
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
