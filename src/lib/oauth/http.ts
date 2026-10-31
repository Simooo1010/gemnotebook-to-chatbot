// HTTP handlers for the OAuth endpoints, with injected deps (unit-testable).
// Never logs or echoes codes, tokens or verifiers.
import { checkOrigin, isOwnerRequest, isSecureEnv, readSessionCookie } from "@/lib/auth/session";
import { approveAuthorization, checkAuthorizeRequest, denyAuthorization } from "./authorize";
import { verifyConsentCsrf } from "./csrf";
import { OAuthError, type OAuthDeps } from "./deps";
import { authorizationServerMetadata, protectedResourceMetadata, resolveBaseUrl } from "./metadata";
import { registerClient } from "./register";
import { exchangeToken } from "./token";
import { revokeAllForClient, revokeEverything, revokeToken } from "./verify";

type Env = Record<string, string | undefined>;

export interface OAuthHttpDeps {
  env: Env;
  /** Lazy: may throw when storage is not configured (→ 503). */
  oauth: () => OAuthDeps;
}

export const CORS_ORIGINS = ["https://claude.ai", "https://claude.com"] as const;
const MAX_BODY = 16 * 1024;

/** CORS only for explicitly allowed origins; never a wildcard, never credentials. */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !(CORS_ORIGINS as readonly string[]).includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Accept, Last-Event-ID",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export const preflight = (request: Request) => new Response(null, { status: 204, headers: corsHeaders(request) });

function json(request: Request | null, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...(request ? corsHeaders(request) : {}), ...extra },
  });
}
/** RFC 6749 §5.2: a 401 invalid_client carries a challenge (public clients send no credentials, so the scheme is only advisory). */
function oauthErr(request: Request, e: OAuthError): Response {
  const extra: Record<string, string> = {};
  if (e.status === 401 && e.error === "invalid_client") extra["WWW-Authenticate"] = 'Basic realm="oauth", charset="UTF-8"';
  return json(request, e.status, { error: e.error, error_description: e.description }, extra);
}
const unavailable = (request: Request) => json(request, 503, { error: "temporarily_unavailable", error_description: "Storage unavailable." });

function deps(d: OAuthHttpDeps): OAuthDeps | null {
  try {
    return d.oauth();
  } catch {
    return null;
  }
}

async function readText(request: Request): Promise<string | null> {
  try {
    const t = await request.text();
    return t.length > MAX_BODY ? null : t;
  } catch {
    return null;
  }
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const t = await readText(request);
  return t === null ? null : new URLSearchParams(t);
}

export function handleMetadata(kind: "resource" | "server", request: Request, env: Env): Response {
  const base = resolveBaseUrl(env.PUBLIC_BASE_URL, request.url);
  return json(request, 200, kind === "resource" ? protectedResourceMetadata(base) : authorizationServerMetadata(base));
}

export async function handleRegister(request: Request, d: OAuthHttpDeps): Promise<Response> {
  const text = await readText(request);
  let body: unknown = null;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const o = deps(d);
  if (!o) return unavailable(request);
  try {
    return json(request, 201, await registerClient(body, o));
  } catch (e) {
    if (e instanceof OAuthError) return oauthErr(request, e);
    return unavailable(request);
  }
}

export async function handleToken(request: Request, d: OAuthHttpDeps): Promise<Response> {
  const form = await readForm(request);
  if (!form) return oauthErr(request, new OAuthError("invalid_request", "Body must be application/x-www-form-urlencoded."));
  const o = deps(d);
  if (!o) return unavailable(request);
  try {
    return json(request, 200, await exchangeToken(form, o, resolveBaseUrl(d.env.PUBLIC_BASE_URL, request.url)));
  } catch (e) {
    if (e instanceof OAuthError) return oauthErr(request, e);
    return unavailable(request);
  }
}

export async function handleRevoke(request: Request, d: OAuthHttpDeps): Promise<Response> {
  const form = await readForm(request);
  const token = form?.get("token");
  if (!form || !token) return oauthErr(request, new OAuthError("invalid_request", "token required"));
  const o = deps(d);
  if (!o) return unavailable(request);
  try {
    await revokeToken(token, form.get("client_id"), o);
    return json(request, 200, {});
  } catch {
    return unavailable(request);
  }
}

const page = (status: number, message: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorization</title><p>${message.replace(/[<>&"]/g, "")}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

/** POST from the consent page: same-origin + owner session + CSRF bound to the session, then approve or deny. */
export async function handleConsent(request: Request, d: OAuthHttpDeps): Promise<Response> {
  if (!checkOrigin(request, d.env.PUBLIC_BASE_URL)) return page(403, "Cross-origin request refused.");
  if (!isOwnerRequest(request, d.env)) return page(401, "Sign in first, then start the connection again.");
  const form = await readForm(request);
  if (!form) return page(400, "Bad request.");
  const session = readSessionCookie(request.headers.get("cookie"), isSecureEnv(d.env));
  if (!verifyConsentCsrf(form.get("csrf"), session, d.env)) return page(403, "This approval form expired. Start the connection again.");
  const o = deps(d);
  if (!o) return page(503, "Storage unavailable.");
  try {
    const check = await checkAuthorizeRequest(form, o, resolveBaseUrl(d.env.PUBLIC_BASE_URL, request.url));
    if (check.kind === "fatal") return page(400, check.message);
    if (check.kind === "redirect") return Response.redirect(check.url, 303);
    const decision = form.get("decision");
    const url = decision === "approve" ? await approveAuthorization(check.request, o) : denyAuthorization(check.request);
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch {
    return page(503, "Storage unavailable.");
  }
}

// ---- Owner "Connected apps" API ---------------------------------------------

function ownerGuard(request: Request, env: Env): Response | null {
  if (!checkOrigin(request, env.PUBLIC_BASE_URL)) return json(null, 403, { error: { code: "forbidden", message: "Cross-origin request refused." } });
  if (!isOwnerRequest(request, env)) return json(null, 401, { error: { code: "unauthorized", message: "Sign in first." } });
  return null;
}

export async function handleOwnerRevokeClient(request: Request, clientId: string, d: OAuthHttpDeps): Promise<Response> {
  const denied = ownerGuard(request, d.env);
  if (denied) return denied;
  const o = deps(d);
  if (!o) return json(null, 503, { error: { code: "unavailable", message: "Storage unavailable." } });
  if (!/^nlm_c_[A-Za-z0-9_-]{1,64}$/.test(clientId)) return json(null, 404, { error: { code: "not_found", message: "App not found." } });
  try {
    await revokeAllForClient(clientId, o);
    return json(null, 200, { ok: true });
  } catch {
    return json(null, 503, { error: { code: "unavailable", message: "Storage unavailable." } });
  }
}

export async function handleOwnerRevokeAll(request: Request, d: OAuthHttpDeps): Promise<Response> {
  const denied = ownerGuard(request, d.env);
  if (denied) return denied;
  const o = deps(d);
  if (!o) return json(null, 503, { error: { code: "unavailable", message: "Storage unavailable." } });
  try {
    return json(null, 200, { ok: true, removed: await revokeEverything(o) });
  } catch {
    return json(null, 503, { error: { code: "unavailable", message: "Storage unavailable." } });
  }
}
