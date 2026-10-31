// RFC 7591 dynamic client registration. Public clients only (PKCE, no secret).
import { randomB64u } from "./crypto";
import { OAuthError, type OAuthDeps } from "./deps";
import type { OAuthClient } from "./store";

export const MAX_REDIRECT_URIS = 5;
export const MAX_CLIENTS = 200;
export const MAX_NAME = 100;
const MAX_URI = 2000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere; http only on loopback. No fragments, wildcards, userinfo. */
export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URI) return false;
  if (raw.includes("*") || raw.includes("#") || /\s/.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || !u.hostname) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

export interface RegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

export async function registerClient(body: unknown, deps: OAuthDeps): Promise<RegistrationResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  if (!uris.every(isValidRedirectUri)) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be https (or http on loopback), without fragment or wildcard.");

  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
  if (b.grant_types !== undefined) {
    if (!Array.isArray(b.grant_types) || !b.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Unsupported grant_types.");
    }
  }
  if (b.response_types !== undefined) {
    if (!Array.isArray(b.response_types) || !b.response_types.every((r) => r === "code")) throw new OAuthError("invalid_client_metadata", "Unsupported response_types.");
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  const clientName = (rawName || "Unnamed app").slice(0, MAX_NAME);

  if ((await deps.store.clients.count()) >= MAX_CLIENTS) throw new OAuthError("invalid_client_metadata", "Too many registered apps. Revoke some on the vault page.", 400);

  const client: OAuthClient = {
    clientId: `nlm_c_${randomB64u(deps.random, 18)}`,
    redirectUris: [...new Set(uris as string[])],
    clientName,
    createdAt: new Date(deps.now()),
  };
  await deps.store.clients.insert(client);
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
