// RFC 7591 dynamic client registration. Public clients only (PKCE, no secret).
import { randomB64u } from "./crypto";
import { OAuthError, type OAuthDeps } from "./deps";
import type { OAuthClient } from "./store";

export const MAX_REDIRECT_URIS = 5;
export const MAX_CLIENTS = 200;
export const MAX_NAME = 100;
const MAX_URI = 2000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Registrations per client IP hash per hour (persistent: counted from oauth_clients.ip_hash). */
export const MAX_REGISTRATIONS_PER_IP_PER_HOUR = 10;
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
/** Registrations younger than this count toward the cap even without a token; older ones only when they hold a token. */
export const FRESH_CLIENT_MS = 60 * 60 * 1000;

/** The only https callbacks Claude uses. Anything else needs its host listed in OAUTH_EXTRA_REDIRECT_HOSTS. */
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] as const;
/** Hosts that get no warning on the consent page. */
export const TRUSTED_REDIRECT_HOSTS = ["claude.ai", "claude.com"] as const;

/** Parses the optional comma-separated OAUTH_EXTRA_REDIRECT_HOSTS (hostnames only, lowercased, no scheme/port/path). */
export function parseExtraRedirectHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h));
}

/** Allow-list: the two Claude callbacks, loopback http (any port/path: Claude Code), or an https host the owner listed. */
export function isAllowedRedirectUri(uri: string, extraHosts: readonly string[] = []): boolean {
  if ((CLAUDE_REDIRECT_URIS as readonly string[]).includes(uri)) return true;
  const u = new URL(uri);
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return u.protocol === "https:" && extraHosts.includes(u.hostname.toLowerCase());
}

/** True when the consent page can show the return host without a warning (https claude.ai / claude.com). */
export function isTrustedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && (TRUSTED_REDIRECT_HOSTS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

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

export interface RegisterOptions {
  /** Hash of the caller's IP, or null when unknown (then no per-IP limit applies; Vercel always sets the header). */
  ipHash?: string | null;
  extraRedirectHosts?: readonly string[];
}

export async function registerClient(body: unknown, deps: OAuthDeps, opts: RegisterOptions = {}): Promise<RegistrationResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  if (!uris.every(isValidRedirectUri)) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be https (or http on loopback), without fragment or wildcard.");
  if (!uris.every((u) => isAllowedRedirectUri(u as string, opts.extraRedirectHosts))) {
    throw new OAuthError("invalid_redirect_uri", "This redirect URI is not allowed for this connector.");
  }

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

  const now = deps.now();
  const sinceIp = new Date(now - REGISTRATION_WINDOW_MS);
  const tooMany = () => new OAuthError("temporarily_unavailable", "Too many registrations from this address. Try again later.", 429);
  if (opts.ipHash && (await deps.store.clients.countRecentByIp(opts.ipHash, sinceIp)) >= MAX_REGISTRATIONS_PER_IP_PER_HOUR) throw tooMany();
  if ((await deps.store.clients.countLive(new Date(now - FRESH_CLIENT_MS))) >= MAX_CLIENTS) {
    throw new OAuthError("invalid_client_metadata", "Too many registered apps. Revoke some on the vault page.", 400);
  }

  const client: OAuthClient = {
    clientId: `nlm_c_${randomB64u(deps.random, 18)}`,
    redirectUris: [...new Set(uris as string[])],
    clientName,
    createdAt: new Date(now),
    ipHash: opts.ipHash ?? null,
    hasToken: false,
  };
  await deps.store.clients.insert(client);
  if (opts.ipHash && (await deps.store.clients.countRecentByIp(opts.ipHash, sinceIp)) > MAX_REGISTRATIONS_PER_IP_PER_HOUR) {
    // Insert-first re-check: a burst of parallel registrations cannot all slip past the read above.
    await deps.store.clients.remove(client.clientId);
    throw tooMany();
  }
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
