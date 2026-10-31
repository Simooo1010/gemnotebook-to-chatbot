// Bearer verification and revocation.
import { sha256hex } from "./crypto";
import type { OAuthDeps } from "./deps";

export type VerifyDeps = Pick<OAuthDeps, "store" | "now">;

export interface AccessGrant {
  clientId: string;
  scope: string;
}

/** Valid, unrevoked, unexpired access token → its grant; anything else → null. Never throws on bad input. */
export async function verifyAccessToken(rawToken: string | null | undefined, deps: VerifyDeps): Promise<AccessGrant | null> {
  if (typeof rawToken !== "string" || !rawToken.startsWith("nlm_at_") || rawToken.length > 200) return null;
  const t = await deps.store.tokens.get(sha256hex(rawToken));
  if (!t || t.kind !== "access" || t.revokedAt !== null || t.expiresAt.getTime() <= deps.now()) return null;
  return { clientId: t.clientId, scope: t.scope };
}

/** RFC 7009. A refresh token revokes its whole family; an access token only itself. Unknown → no-op. */
export async function revokeToken(rawToken: string, clientId: string | null, deps: VerifyDeps): Promise<void> {
  if (rawToken.length === 0 || rawToken.length > 200) return;
  const hash = sha256hex(rawToken);
  const t = await deps.store.tokens.get(hash);
  if (!t || (clientId !== null && t.clientId !== clientId)) return;
  const at = new Date(deps.now());
  if (t.kind === "refresh") await deps.store.tokens.revokeFamily(t.familyId, at);
  else await deps.store.tokens.claim(hash, at);
}

/** Owner action: revoke every token of the app and remove its registration. */
export async function revokeAllForClient(clientId: string, deps: VerifyDeps): Promise<void> {
  await deps.store.tokens.revokeClient(clientId, new Date(deps.now()));
  await deps.store.clients.remove(clientId);
}

/** Owner action: revoke every token and remove every registration. Returns how many apps were removed. */
export async function revokeEverything(deps: VerifyDeps): Promise<number> {
  await deps.store.tokens.revokeAll(new Date(deps.now()));
  const clients = await deps.store.clients.list();
  for (const c of clients) await deps.store.clients.remove(c.clientId);
  return clients.length;
}
