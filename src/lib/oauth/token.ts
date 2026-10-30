// Token endpoint: authorization_code (PKCE S256) and refresh_token (rotation + reuse detection).
import { randomB64u, sha256hex, verifyPkce } from "./crypto";
import { ACCESS_TTL_MS, OAuthError, REFRESH_TTL_MS, type OAuthDeps } from "./deps";
import { mcpResourceUrl } from "./metadata";

type Params = { get(name: string): string | null };

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const invalidGrant = (d: string) => new OAuthError("invalid_grant", d);

async function issuePair(deps: OAuthDeps, clientId: string, scope: string, familyId: string): Promise<TokenResponse> {
  const now = deps.now();
  const access = `nlm_at_${randomB64u(deps.random, 32)}`;
  const refresh = `nlm_rt_${randomB64u(deps.random, 32)}`;
  const base = { clientId, scope, familyId, revokedAt: null, createdAt: new Date(now) };
  await deps.store.tokens.insert({ ...base, tokenHash: sha256hex(access), kind: "access", expiresAt: new Date(now + ACCESS_TTL_MS) });
  await deps.store.tokens.insert({ ...base, tokenHash: sha256hex(refresh), kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_MS) });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope };
}

export async function exchangeToken(params: Params, deps: OAuthDeps, base: string): Promise<TokenResponse> {
  const grant = params.get("grant_type");
  const clientId = params.get("client_id");
  if (!clientId) throw new OAuthError("invalid_client", "client_id required", 401);
  if (!(await deps.store.clients.get(clientId))) throw new OAuthError("invalid_client", "unknown client", 401);
  const resource = params.get("resource");
  if (resource !== null && resource !== mcpResourceUrl(base)) throw new OAuthError("invalid_target", "unknown resource");

  if (grant === "authorization_code") return codeGrant(params, clientId, deps);
  if (grant === "refresh_token") return refreshGrant(params, clientId, deps);
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

async function codeGrant(params: Params, clientId: string, deps: OAuthDeps): Promise<TokenResponse> {
  const code = params.get("code");
  if (!code || code.length > 200) throw invalidGrant("invalid code");
  const res = await deps.store.codes.consume(sha256hex(code));
  if (res.status === "missing") throw invalidGrant("invalid code");
  if (res.status === "reused") {
    // RFC 6749 §4.1.2: a reused code revokes everything issued from it.
    await deps.store.tokens.revokeFamily(res.code.familyId, new Date(deps.now()));
    throw invalidGrant("code already used");
  }
  const c = res.code;
  if (c.clientId !== clientId) throw invalidGrant("invalid code");
  if (c.expiresAt.getTime() <= deps.now()) throw invalidGrant("code expired");
  if (params.get("redirect_uri") !== c.redirectUri) throw invalidGrant("redirect_uri mismatch");
  if (!verifyPkce(params.get("code_verifier"), c.codeChallenge)) throw invalidGrant("PKCE verification failed");
  return issuePair(deps, clientId, c.scope, c.familyId);
}

async function refreshGrant(params: Params, clientId: string, deps: OAuthDeps): Promise<TokenResponse> {
  const raw = params.get("refresh_token");
  if (!raw || !raw.startsWith("nlm_rt_") || raw.length > 200) throw invalidGrant("invalid refresh token");
  const hash = sha256hex(raw);
  const t = await deps.store.tokens.get(hash);
  const now = new Date(deps.now());
  if (!t || t.kind !== "refresh" || t.clientId !== clientId) throw invalidGrant("invalid refresh token");
  if (t.revokedAt !== null) {
    // A rotated (already used) refresh token came back: assume theft, kill the family.
    await deps.store.tokens.revokeFamily(t.familyId, now);
    throw invalidGrant("refresh token reused");
  }
  if (t.expiresAt.getTime() <= now.getTime()) throw invalidGrant("refresh token expired");
  if (!(await deps.store.tokens.claim(hash, now))) {
    await deps.store.tokens.revokeFamily(t.familyId, now);
    throw invalidGrant("refresh token reused");
  }
  return issuePair(deps, clientId, t.scope, t.familyId);
}
