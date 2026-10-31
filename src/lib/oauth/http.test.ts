import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/next";
import { createSessionToken } from "@/lib/auth/session";
import { s256 } from "./crypto";
import { consentCsrfToken } from "./csrf";
import { defaultRandom } from "./crypto";
import { corsHeaders, handleConsent, handleMetadata, handleOwnerRevokeAll, handleRegister, handleToken, type OAuthHttpDeps } from "./http";
import { createMemoryStore } from "./store";

const ORIGIN = "http://localhost:3000";
const env = { OAUTH_SIGNING_KEY: "k".repeat(40), NODE_ENV: "test" };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(50);

function mk(): OAuthHttpDeps {
  const store = createMemoryStore();
  return { env, oauth: () => ({ store, now: Date.now, random: defaultRandom }) };
}

const session = () => createSessionToken(env).token;

function consentReq(fields: Record<string, string>, opts: { cookie?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", origin: opts.origin ?? ORIGIN };
  if (opts.cookie !== null) headers.cookie = `owner-dev=${opts.cookie ?? ""}`;
  return new Request(`${ORIGIN}/oauth/consent`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

async function registered(d: OAuthHttpDeps) {
  const res = await handleRegister(new Request(`${ORIGIN}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) }), d);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authFields = (clientId: string) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: s256(VERIFIER),
  code_challenge_method: "S256",
  state: "xyz",
});

describe("consent POST", () => {
  it("approve → code redirect; then token exchange works", async () => {
    const d = mk();
    const id = await registered(d);
    const tok = session();
    const res = await handleConsent(consentReq({ ...authFields(id), csrf: consentCsrfToken(tok, env)!, decision: "approve" }, { cookie: tok }), d);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;
    const t = await handleToken(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://claude.ai" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: id, code, redirect_uri: REDIRECT, code_verifier: VERIFIER }).toString(),
      }),
      d,
    );
    expect(t.status).toBe(200);
    expect(t.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(t.headers.get("cache-control")).toBe("no-store");
  });
  it("deny → access_denied redirect without code", async () => {
    const d = mk();
    const id = await registered(d);
    const tok = session();
    const res = await handleConsent(consentReq({ ...authFields(id), csrf: consentCsrfToken(tok, env)!, decision: "deny" }, { cookie: tok }), d);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.has("code")).toBe(false);
  });
  it("rejects missing/foreign CSRF, no session, cross-origin", async () => {
    const d = mk();
    const id = await registered(d);
    const tok = session();
    const other = session();
    expect((await handleConsent(consentReq({ ...authFields(id), decision: "approve" }, { cookie: tok }), d)).status).toBe(403);
    expect((await handleConsent(consentReq({ ...authFields(id), csrf: consentCsrfToken(other, env)!, decision: "approve" }, { cookie: tok }), d)).status).toBe(403);
    expect((await handleConsent(consentReq({ ...authFields(id), csrf: consentCsrfToken(tok, env)!, decision: "approve" }, { cookie: null }), d)).status).toBe(401);
    expect(
      (await handleConsent(consentReq({ ...authFields(id), csrf: consentCsrfToken(tok, env)!, decision: "approve" }, { cookie: tok, origin: "https://evil.example" }), d)).status,
    ).toBe(403);
  });
  it("tampered redirect_uri is refused without redirect", async () => {
    const d = mk();
    const id = await registered(d);
    const tok = session();
    const res = await handleConsent(consentReq({ ...authFields(id), redirect_uri: "https://evil.example/cb", csrf: consentCsrfToken(tok, env)!, decision: "approve" }, { cookie: tok }), d);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("endpoints", () => {
  it("token requires form encoding", async () => {
    const res = await handleToken(new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), mk());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });
  it("storage failure → 503", async () => {
    const res = await handleRegister(new Request(`${ORIGIN}/oauth/register`, { method: "POST", body: "{}" }), {
      env,
      oauth: () => {
        throw new Error("x");
      },
    });
    expect(res.status).toBe(503);
  });
  it("CORS only for claude.ai / claude.com, never wildcard", () => {
    const h = (o: string) => corsHeaders(new Request(ORIGIN, { headers: { origin: o } }))["Access-Control-Allow-Origin"];
    expect(h("https://claude.ai")).toBe("https://claude.ai");
    expect(h("https://claude.com")).toBe("https://claude.com");
    expect(h("https://evil.example")).toBeUndefined();
  });
  it("CORS lists the MCP headers and DELETE", () => {
    const h = corsHeaders(new Request(ORIGIN, { headers: { origin: "https://claude.ai" } }));
    for (const x of ["Mcp-Session-Id", "Accept", "Last-Event-ID", "Authorization", "Content-Type", "MCP-Protocol-Version"]) expect(h["Access-Control-Allow-Headers"]).toContain(x);
    expect(h["Access-Control-Allow-Methods"]).toContain("DELETE");
  });
  it("token: invalid_client is 401 with a WWW-Authenticate challenge", async () => {
    const res = await handleToken(
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&client_id=nlm_c_nope" }),
      mk(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
  it("metadata uses PUBLIC_BASE_URL", async () => {
    const res = handleMetadata("resource", new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), { PUBLIC_BASE_URL: "https://nlm.example.com" });
    expect(await res.json()).toMatchObject({ resource: "https://nlm.example.com/api/mcp" });
  });
  it("owner revoke-all requires session + same origin", async () => {
    const d = mk();
    const post = (h: Record<string, string>) => handleOwnerRevokeAll(new Request(`${ORIGIN}/api/vault/apps/revoke-all`, { method: "POST", headers: h }), d);
    expect((await post({ origin: ORIGIN })).status).toBe(401);
    expect((await post({ origin: "https://evil.example", cookie: `owner-dev=${session()}` })).status).toBe(403);
    expect((await post({ origin: ORIGIN, cookie: `owner-dev=${session()}` })).status).toBe(200);
  });
});

describe("safeNextPath", () => {
  it("accepts same-origin paths only", () => {
    expect(safeNextPath("/oauth/authorize?client_id=a&x=1")).toBe("/oauth/authorize?client_id=a&x=1");
    expect(safeNextPath("/vault")).toBe("/vault");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "vault", "", "/%0d%0a", "/a\nb", null, 3]) {
      const r = safeNextPath(bad);
      expect(r === null || r.startsWith("/") && !r.startsWith("//")).toBe(true);
      if (bad !== "/%0d%0a") expect(r).toBeNull();
    }
  });
});
