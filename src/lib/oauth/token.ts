// Token endpoint: authorization_code (PKCE S256) and refresh_token (rotation + reuse detection).
import { randomB64u, sha256hex, verifyPkce } from "./crypto";
import { ACCESS_TTL_MS, OAuthError, REFRESH_TTL_MS, type OAuthDeps } from "./deps";
import { mcpResourceUrl } from "./metadata";
import type { TokenRecord } from "./store";

type Params = { get(name: string): string | null };

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * A refresh token that was already rotated may be presented again by the same client inside this window (network retry,
 * two workers refreshing at once). That is NOT treated as theft: it gets a fresh pair in the same family (both pairs stay
 * valid). Reuse after the window revokes the whole family.
 */
export const REFRESH_GRACE_MS = 20_000;

const invalidGrant = (d: string) => new OAuthError("invalid_grant", d);

/**
 * Revokes a family so that the revocation also wins against an issuance in flight: the tombstone is written FIRST (a
 * concurrent `issueChecked` that finishes later sees it and revokes its own rows), then every live row is revoked
 * (a concurrent issuance that finished earlier is caught by that second step).
 */
async function killFamily(deps: OAuthDeps, familyId: string, clientId: string, at: Date): Promise<void> {
  await deps.store.tokens.tombstoneFamily(familyId, clientId, at);
  await deps.store.tokens.revokeFamily(familyId, at);
}

/** Issues a pair, then re-checks that the family was not revoked meanwhile; if it was, the new rows are revoked and the grant fails. */
async function issueChecked(deps: OAuthDeps, clientId: string, scope: string, familyId: string): Promise<TokenResponse> {
  const pair = await issuePair(deps, clientId, scope, familyId);
  if (await deps.store.tokens.familyRevoked(familyId)) {
    await deps.store.tokens.revokeFamily(familyId, new Date(deps.now()));
    throw invalidGrant("grant revoked");
  }
  return pair;
}

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
    await killFamily(deps, res.code.familyId, res.code.clientId, new Date(deps.now()));
    throw invalidGrant("code already used");
  }
  const c = res.code;
  if (c.clientId !== clientId) throw invalidGrant("invalid code");
  if (c.expiresAt.getTime() <= deps.now()) throw invalidGrant("code expired");
  if (params.get("redirect_uri") !== c.redirectUri) throw invalidGrant("redirect_uri mismatch");
  if (!verifyPkce(params.get("code_verifier"), c.codeChallenge)) throw invalidGrant("PKCE verification failed");
  const pair = await issueChecked(deps, clientId, c.scope, c.familyId);
  await deps.store.clients.markHasToken(clientId).catch(() => undefined); // only feeds the registration cap
  return pair;
}

/** True when `t` was revoked by rotation recently enough (and its family is intact) to answer a retried refresh. */
async function inGrace(deps: OAuthDeps, t: TokenRecord, now: Date): Promise<boolean> {
  if (!t.rotated || t.revokedAt === null) return false;
  if (now.getTime() - t.revokedAt.getTime() > REFRESH_GRACE_MS || t.expiresAt.getTime() <= now.getTime()) return false;
  return !(await deps.store.tokens.familyRevoked(t.familyId));
}

async function refreshGrant(params: Params, clientId: string, deps: OAuthDeps): Promise<TokenResponse> {
  const raw = params.get("refresh_token");
  if (!raw || !raw.startsWith("nlm_rt_") || raw.length > 200) throw invalidGrant("invalid refresh token");
  const hash = sha256hex(raw);
  const t = await deps.store.tokens.get(hash);
  const now = new Date(deps.now());
  if (!t || t.kind !== "refresh" || t.clientId !== clientId) throw invalidGrant("invalid refresh token");
  if (t.revokedAt !== null) {
    if (await inGrace(deps, t, now)) return issueChecked(deps, clientId, t.scope, t.familyId);
    // A rotated (already used) refresh token came back late: assume theft, kill the family.
    await killFamily(deps, t.familyId, clientId, now);
    throw invalidGrant("refresh token reused");
  }
  if (t.expiresAt.getTime() <= now.getTime()) throw invalidGrant("refresh token expired");
  if (!(await deps.store.tokens.claim(hash, now, true))) {
    // Lost a race for the same token: if the winner rotated it a moment ago this is a retry, not theft.
    const again = await deps.store.tokens.get(hash);
    if (again && (await inGrace(deps, again, now))) return issueChecked(deps, clientId, t.scope, t.familyId);
    await killFamily(deps, t.familyId, clientId, now);
    throw invalidGrant("refresh token reused");
  }
  return issueChecked(deps, clientId, t.scope, t.familyId);
}
