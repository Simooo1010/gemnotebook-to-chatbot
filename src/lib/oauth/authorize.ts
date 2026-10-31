// Authorization endpoint logic: validate, build the consent view-model, issue single-use codes.
import { CHALLENGE_RE, randomB64u, sha256hex } from "./crypto";
import { CODE_TTL_MS, type OAuthDeps } from "./deps";
import { mcpResourceUrl } from "./metadata";
import { SCOPE } from "./store";

type Params = { get(name: string): string | null };

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string | null;
}

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  scopeText: string;
}

export type AuthorizeCheck =
  /** Client or redirect URI cannot be trusted: show an error page, never redirect. */
  | { kind: "fatal"; message: string }
  /** Request is bad but the redirect URI is a registered one: send the error back to the client. */
  | { kind: "redirect"; url: string }
  | { kind: "ok"; request: AuthRequest; view: ConsentView };

const MAX_STATE = 1024;

export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

export const SCOPE_TEXT = "Use your NotebookLM notebooks through this connector: list, read and create notebooks and sources, chat, and create audio/video overviews.";

export async function checkAuthorizeRequest(params: Params, deps: OAuthDeps, base: string): Promise<AuthorizeCheck> {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || clientId.length > 200) return { kind: "fatal", message: "Missing or unknown app (client_id)." };
  const client = await deps.store.clients.get(clientId);
  if (!client) return { kind: "fatal", message: "Unknown app. It must register again." };
  // Exact string match against a registered URI (no prefix/normalised matching).
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { kind: "fatal", message: "The return address does not match the app's registration." };

  const state = params.get("state");
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: "redirect",
    url: redirectWith(redirectUri, { error, error_description: description, state: state && state.length <= MAX_STATE ? state : null }),
  });

  if (state !== null && state.length > MAX_STATE) return fail("invalid_request", "state too long");
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  const challenge = params.get("code_challenge");
  if (!challenge) return fail("invalid_request", "code_challenge required");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (!CHALLENGE_RE.test(challenge)) return fail("invalid_request", "malformed code_challenge");

  const rawScope = params.get("scope");
  const scopes = (rawScope ?? SCOPE).split(" ").filter(Boolean);
  if (!scopes.every((s) => s === SCOPE)) return fail("invalid_scope", `only scope ${SCOPE} is supported`);

  const resource = params.get("resource");
  if (resource !== null && resource !== mcpResourceUrl(base)) return fail("invalid_target", "unknown resource");

  return {
    kind: "ok",
    request: { clientId, redirectUri, codeChallenge: challenge, state, scope: SCOPE, resource },
    view: { clientName: client.clientName, redirectHost: new URL(redirectUri).host, scopeText: SCOPE_TEXT },
  };
}

/** Issues a single-use code (32 random bytes, 60 s) and returns the redirect URL. Only the hash is stored. */
export async function approveAuthorization(req: AuthRequest, deps: OAuthDeps): Promise<string> {
  const code = randomB64u(deps.random, 32);
  await deps.store.codes.insert({
    codeHash: sha256hex(code),
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    scope: req.scope,
    resource: req.resource,
    familyId: randomB64u(deps.random, 16),
    expiresAt: new Date(deps.now() + CODE_TTL_MS),
    used: false,
  });
  return redirectWith(req.redirectUri, { code, state: req.state });
}

export function denyAuthorization(req: AuthRequest): string {
  return redirectWith(req.redirectUri, { error: "access_denied", error_description: "The owner denied access", state: req.state });
}
