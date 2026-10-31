import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approveAuthorization, checkAuthorizeRequest, denyAuthorization } from "./authorize";
import { s256, sha256hex, verifyPkce } from "./crypto";
import { ACCESS_TTL_MS, CODE_TTL_MS, OAuthError, REFRESH_TTL_MS, type OAuthDeps } from "./deps";
import { authorizationServerMetadata, protectedResourceMetadata, resolveBaseUrl } from "./metadata";
import { isAllowedRedirectUri, isTrustedRedirectUri, isValidRedirectUri, MAX_CLIENTS, MAX_REGISTRATIONS_PER_IP_PER_HOUR, parseExtraRedirectHosts, REGISTRATION_WINDOW_MS, registerClient } from "./register";
import { createMemoryStore, type OAuthStore, type TokenRecord } from "./store";
import { exchangeToken, REFRESH_GRACE_MS, type TokenResponse } from "./token";
import { revokeAllForClient, revokeEverything, revokeToken, verifyAccessToken } from "./verify";

const BASE = "https://nlm.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(10);

/** Store wrapper that records every value written, to prove raw secrets never reach it. */
function setup() {
  const inner = createMemoryStore();
  const written: string[] = [];
  const spy = <T extends object>(o: T): T =>
    new Proxy(o, {
      get(t, k) {
        const f = (t as Record<string | symbol, unknown>)[k];
        if (typeof f !== "function") return f;
        return (...args: unknown[]) => {
          written.push(JSON.stringify(args));
          return (f as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  const store: OAuthStore = { clients: spy(inner.clients), codes: spy(inner.codes), tokens: spy(inner.tokens) };
  const clock = { t: 1_800_000_000_000 };
  const deps: OAuthDeps = { store, now: () => clock.t, random: (n) => randomBytes(n) };
  return { deps, clock, written, inner };
}

const q = (o: Record<string, string>) => new URLSearchParams(o);

async function register(deps: OAuthDeps) {
  return registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] }, deps);
}

function authParams(clientId: string, extra: Record<string, string> = {}) {
  return q({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: s256(VERIFIER), code_challenge_method: "S256", state: "st-1", ...extra });
}

async function getCode(deps: OAuthDeps, clientId: string) {
  const check = await checkAuthorizeRequest(authParams(clientId), deps, BASE);
  if (check.kind !== "ok") throw new Error("expected ok");
  const url = new URL(await approveAuthorization(check.request, deps));
  return url.searchParams.get("code")!;
}

const codeGrant = (clientId: string, code: string, extra: Record<string, string> = {}) =>
  q({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...extra });

async function fullFlow() {
  const s = setup();
  const { client_id } = await register(s.deps);
  const code = await getCode(s.deps, client_id);
  const tokens = await exchangeToken(codeGrant(client_id, code), s.deps, BASE);
  return { ...s, clientId: client_id, code, tokens };
}

async function expectGrantError(p: Promise<unknown>, error = "invalid_grant") {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OAuthError && e.error === error);
}

describe("PKCE", () => {
  it("accepts the right verifier, rejects wrong/short/non-string", () => {
    const c = s256(VERIFIER);
    expect(verifyPkce(VERIFIER, c)).toBe(true);
    expect(verifyPkce(VERIFIER + "x", c)).toBe(false);
    expect(verifyPkce("short", s256("short"))).toBe(false);
    expect(verifyPkce(undefined, c)).toBe(false);
  });
  it("RFC 7636 appendix B vector", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("rejects plain method and missing challenge at authorize", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    const plain = await checkAuthorizeRequest(authParams(client_id, { code_challenge_method: "plain", code_challenge: VERIFIER }), deps, BASE);
    expect(plain.kind).toBe("redirect");
    const p = authParams(client_id);
    p.delete("code_challenge");
    const missing = await checkAuthorizeRequest(p, deps, BASE);
    expect(missing.kind === "redirect" && new URL(missing.url).searchParams.get("error")).toBe("invalid_request");
  });
  it("token exchange fails with the wrong verifier", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    const code = await getCode(deps, client_id);
    await expectGrantError(exchangeToken(codeGrant(client_id, code, { code_verifier: "w".repeat(43) }), deps, BASE));
  });
});

describe("authorization code", () => {
  it("issues tokens with the right shape and TTLs", async () => {
    const { tokens } = await fullFlow();
    expect(tokens.access_token).toMatch(/^nlm_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^nlm_rt_[A-Za-z0-9_-]{43}$/);
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("notebooklm");
  });
  it("is single-use; reuse revokes the token family", async () => {
    const { deps, clientId, code, tokens } = await fullFlow();
    expect(await verifyAccessToken(tokens.access_token, deps)).toEqual({ clientId, scope: "notebooklm" });
    await expectGrantError(exchangeToken(codeGrant(clientId, code), deps, BASE));
    expect(await verifyAccessToken(tokens.access_token, deps)).toBeNull();
    await expectGrantError(exchangeToken(q({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }), deps, BASE));
  });
  it("expires after 60 s", async () => {
    const { deps, clock } = setup();
    const { client_id } = await register(deps);
    const code = await getCode(deps, client_id);
    clock.t += CODE_TTL_MS;
    await expectGrantError(exchangeToken(codeGrant(client_id, code), deps, BASE));
  });
  it("requires the same redirect_uri and client", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    const other = await register(deps);
    const code = await getCode(deps, client_id);
    await expectGrantError(exchangeToken(codeGrant(client_id, code, { redirect_uri: REDIRECT + "x" }), deps, BASE));
    const code2 = await getCode(deps, client_id);
    await expectGrantError(exchangeToken(codeGrant(other.client_id, code2), deps, BASE));
  });
  it("rejects unknown client and grant type", async () => {
    const { deps } = setup();
    await expectGrantError(exchangeToken(codeGrant("nope", "x"), deps, BASE), "invalid_client");
    const { client_id } = await register(deps);
    await expectGrantError(exchangeToken(q({ grant_type: "password", client_id }), deps, BASE), "unsupported_grant_type");
  });
});

describe("refresh rotation", () => {
  const refresh = (deps: OAuthDeps, clientId: string, rt: string) =>
    exchangeToken(q({ grant_type: "refresh_token", client_id: clientId, refresh_token: rt }), deps, BASE);

  it("rotates: new pair; a LATE reuse of the old refresh token revokes the family", async () => {
    const { deps, clientId, tokens, clock } = await fullFlow();
    const next: TokenResponse = await refresh(deps, clientId, tokens.refresh_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await verifyAccessToken(next.access_token, deps)).not.toBeNull();
    clock.t += REFRESH_GRACE_MS + 1;
    await expectGrantError(refresh(deps, clientId, tokens.refresh_token));
    expect(await verifyAccessToken(next.access_token, deps)).toBeNull();
    await expectGrantError(refresh(deps, clientId, next.refresh_token));
  });
  it("grace window: a retry of an already rotated token inside 20 s gets a fresh pair; both pairs stay valid", async () => {
    const { deps, clientId, tokens, clock } = await fullFlow();
    const first = await refresh(deps, clientId, tokens.refresh_token);
    clock.t += REFRESH_GRACE_MS - 1;
    const retry = await refresh(deps, clientId, tokens.refresh_token);
    expect(retry.refresh_token).not.toBe(first.refresh_token);
    for (const t of [first, retry]) expect(await verifyAccessToken(t.access_token, deps)).not.toBeNull();
    await refresh(deps, clientId, first.refresh_token);
    await refresh(deps, clientId, retry.refresh_token);
  });
  it("grace window ends: the same retry 1 ms later is reuse and revokes everything", async () => {
    const { deps, clientId, tokens, clock } = await fullFlow();
    const first = await refresh(deps, clientId, tokens.refresh_token);
    clock.t += REFRESH_GRACE_MS + 1;
    await expectGrantError(refresh(deps, clientId, tokens.refresh_token));
    expect(await verifyAccessToken(first.access_token, deps)).toBeNull();
    await expectGrantError(refresh(deps, clientId, first.refresh_token));
  });
  it("no grace once the family was revoked (owner revoke / theft), even inside the window", async () => {
    const { deps, clientId, tokens } = await fullFlow();
    const first = await refresh(deps, clientId, tokens.refresh_token);
    await revokeToken(first.refresh_token, clientId, deps);
    await expectGrantError(refresh(deps, clientId, tokens.refresh_token));
    expect(await verifyAccessToken(first.access_token, deps)).toBeNull();
  });
  it("revoking a single access token does not kill the family or block the next refresh", async () => {
    const { deps, clientId, tokens } = await fullFlow();
    await revokeToken(tokens.access_token, clientId, deps);
    const next = await refresh(deps, clientId, tokens.refresh_token);
    expect(await verifyAccessToken(next.access_token, deps)).not.toBeNull();
  });
  it("grace is per client: another client cannot use the retry window", async () => {
    const { deps, clientId, tokens } = await fullFlow();
    const other = await register(deps);
    await refresh(deps, clientId, tokens.refresh_token);
    await expectGrantError(refresh(deps, other.client_id, tokens.refresh_token));
  });
  it("refresh expires after 30 days; access after 1 h", async () => {
    const { deps, clientId, tokens, clock } = await fullFlow();
    clock.t += ACCESS_TTL_MS;
    expect(await verifyAccessToken(tokens.access_token, deps)).toBeNull();
    clock.t += REFRESH_TTL_MS;
    await expectGrantError(refresh(deps, clientId, tokens.refresh_token));
  });
  it("refresh token cannot be used as access token and vice versa", async () => {
    const { deps, clientId, tokens } = await fullFlow();
    expect(await verifyAccessToken(tokens.refresh_token, deps)).toBeNull();
    await expectGrantError(refresh(deps, clientId, tokens.access_token));
  });
});

describe("hashing", () => {
  it("raw codes and tokens never reach the store", async () => {
    const { written, code, tokens, inner } = await fullFlow();
    const all = written.join("\n");
    for (const raw of [code, tokens.access_token, tokens.refresh_token, VERIFIER]) expect(all).not.toContain(raw);
    const t = (await inner.tokens.get(sha256hex(tokens.access_token))) as TokenRecord;
    expect(t.kind).toBe("access");
  });
});

describe("revocation", () => {
  it("revokeToken: access only itself, refresh the family", async () => {
    const a = await fullFlow();
    await revokeToken(a.tokens.access_token, null, a.deps);
    expect(await verifyAccessToken(a.tokens.access_token, a.deps)).toBeNull();
    const b = await fullFlow();
    await revokeToken(b.tokens.refresh_token, "someone-else", b.deps);
    expect(await verifyAccessToken(b.tokens.access_token, b.deps)).not.toBeNull();
    await revokeToken(b.tokens.refresh_token, b.clientId, b.deps);
    expect(await verifyAccessToken(b.tokens.access_token, b.deps)).toBeNull();
  });
  it("revokeAllForClient and revokeEverything remove apps", async () => {
    const a = await fullFlow();
    await revokeAllForClient(a.clientId, a.deps);
    expect(await verifyAccessToken(a.tokens.access_token, a.deps)).toBeNull();
    expect(await a.deps.store.clients.get(a.clientId)).toBeNull();
    const b = await fullFlow();
    await register(b.deps);
    expect(await revokeEverything(b.deps)).toBe(2);
    expect(await verifyAccessToken(b.tokens.access_token, b.deps)).toBeNull();
  });
  it("verify rejects junk", async () => {
    const { deps } = setup();
    for (const t of [null, undefined, "", "nlm_at_x", "Bearer x", "nlm_at_" + "a".repeat(300)]) expect(await verifyAccessToken(t, deps)).toBeNull();
  });
});

describe("authorize validation", () => {
  it("unknown client or non-exact redirect → fatal (never redirects)", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    expect((await checkAuthorizeRequest(authParams("nlm_c_unknown"), deps, BASE)).kind).toBe("fatal");
    for (const r of [REDIRECT + "/", REDIRECT + "?x=1", "https://evil.example/cb", "https://claude.ai/api/mcp/auth_callback#x", REDIRECT.toUpperCase()]) {
      expect((await checkAuthorizeRequest(authParams(client_id, { redirect_uri: r }), deps, BASE)).kind).toBe("fatal");
    }
  });
  it("scope and resource checks; state passthrough; view-model", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    const bad = await checkAuthorizeRequest(authParams(client_id, { scope: "notebooklm admin" }), deps, BASE);
    expect(bad.kind === "redirect" && new URL(bad.url).searchParams.get("error")).toBe("invalid_scope");
    const res = await checkAuthorizeRequest(authParams(client_id, { resource: "https://other/api/mcp" }), deps, BASE);
    expect(res.kind === "redirect" && new URL(res.url).searchParams.get("state")).toBe("st-1");
    const ok = await checkAuthorizeRequest(authParams(client_id, { resource: `${BASE}/api/mcp`, scope: "notebooklm" }), deps, BASE);
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") return;
    expect(ok.view).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai" });
    expect(new URL(await approveAuthorization(ok.request, deps)).searchParams.get("state")).toBe("st-1");
    const denied = new URL(denyAuthorization(ok.request));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("code")).toBeNull();
    expect(denied.origin + denied.pathname).toBe(REDIRECT);
  });
  it("rejects wrong response_type", async () => {
    const { deps } = setup();
    const { client_id } = await register(deps);
    const r = await checkAuthorizeRequest(authParams(client_id, { response_type: "token" }), deps, BASE);
    expect(r.kind === "redirect" && new URL(r.url).searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("dynamic client registration", () => {
  it("validates redirect URIs", () => {
    for (const ok of [REDIRECT, "http://127.0.0.1:3000/cb", "http://localhost/cb", "http://[::1]:8080/cb"]) expect(isValidRedirectUri(ok)).toBe(true);
    for (const bad of ["http://claude.ai/cb", "https://claude.ai/cb#f", "https://*.claude.ai/cb", "javascript:alert(1)", "https://u:p@claude.ai/cb", "/relative", "", 5]) {
      expect(isValidRedirectUri(bad)).toBe(false);
    }
  });
  it("enforces caps and public-client only", async () => {
    const { deps } = setup();
    const err = (body: unknown) => expectGrantError(registerClient(body, deps), "invalid_redirect_uri");
    await err({ redirect_uris: [] });
    await err({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) });
    await expectGrantError(registerClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, deps), "invalid_client_metadata");
    await expectGrantError(registerClient(null, deps), "invalid_client_metadata");
    const r = await registerClient({ redirect_uris: [REDIRECT], client_name: "x".repeat(500) }, deps);
    expect(r.client_name.length).toBe(100);
    expect(r.client_id).toMatch(/^nlm_c_/);
    expect(r.token_endpoint_auth_method).toBe("none");
  });
  it("caps the total number of clients", async () => {
    const { deps } = setup();
    for (let i = 0; i < MAX_CLIENTS; i++) await register(deps);
    await expectGrantError(register(deps), "invalid_client_metadata");
  });
});

describe("metadata", () => {
  it("builds both documents", () => {
    expect(protectedResourceMetadata(BASE)).toMatchObject({ resource: `${BASE}/api/mcp`, authorization_servers: [BASE] });
    expect(authorizationServerMetadata(BASE)).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["notebooklm"],
    });
  });
  it("base URL: env first, else request origin", () => {
    expect(resolveBaseUrl("https://x.example/", "http://y/a")).toBe("https://x.example");
    expect(resolveBaseUrl(undefined, "https://y.example/a?b")).toBe("https://y.example");
  });
});

/** Store whose token inserts take a macrotask, so concurrent grants really interleave (the memory store is otherwise atomic). */
function withTokenInsert(deps: OAuthDeps, insert: (real: OAuthDeps["store"]["tokens"], t: TokenRecord) => Promise<void>): OAuthDeps {
  const real = deps.store.tokens; // the memory store's methods are closures, so spreading it is safe
  return { ...deps, store: { ...deps.store, tokens: { ...real, insert: (t) => insert(real, t) } } };
}
const slowInserts = (deps: OAuthDeps, ms = 2) =>
  withTokenInsert(deps, async (real, t) => {
    await new Promise((r) => setTimeout(r, ms));
    await real.insert(t);
  });

describe("token races", () => {
  const refresh = (deps: OAuthDeps, clientId: string, rt: string) =>
    exchangeToken(q({ grant_type: "refresh_token", client_id: clientId, refresh_token: rt }), deps, BASE);

  it("concurrent double refresh: both succeed and the session keeps working", async () => {
    for (let round = 0; round < 20; round++) {
      const f = await fullFlow();
      const deps = slowInserts(f.deps, round % 4);
      const [a, b] = await Promise.all([refresh(deps, f.clientId, f.tokens.refresh_token), refresh(deps, f.clientId, f.tokens.refresh_token)]);
      for (const t of [a, b]) expect(await verifyAccessToken(t.access_token, f.deps)).not.toBeNull();
      await refresh(f.deps, f.clientId, a.refresh_token);
      await refresh(f.deps, f.clientId, b.refresh_token);
    }
  });

  it("concurrent double code exchange: at most one 200, and no token of the family stays alive", async () => {
    for (let round = 0; round < 20; round++) {
      const s = setup();
      const { client_id } = await register(s.deps);
      const code = await getCode(s.deps, client_id);
      const deps = slowInserts(s.deps, round % 4);
      const results = await Promise.allSettled([exchangeToken(codeGrant(client_id, code), deps, BASE), exchangeToken(codeGrant(client_id, code), deps, BASE)]);
      const ok = results.filter((r): r is PromiseFulfilledResult<TokenResponse> => r.status === "fulfilled");
      expect(ok.length).toBeLessThanOrEqual(1);
      expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThanOrEqual(1);
      for (const r of ok) {
        expect(await verifyAccessToken(r.value.access_token, s.deps)).toBeNull();
        await expectGrantError(refresh(s.deps, client_id, r.value.refresh_token));
      }
    }
  });

  it("issueChecked: a family revoked while the pair is being written revokes the new rows and fails the grant", async () => {
    const s = setup();
    const { client_id } = await register(s.deps);
    const code = await getCode(s.deps, client_id);
    // The replay (second exchange of the same code) is processed completely between the winner's first and second insert.
    let n = 0;
    const inserted: string[] = [];
    const deps = withTokenInsert(s.deps, async (real, t) => {
      await real.insert(t);
      inserted.push(t.tokenHash);
      if (++n === 1) await expectGrantError(exchangeToken(codeGrant(client_id, code), s.deps, BASE));
    });
    await expectGrantError(exchangeToken(codeGrant(client_id, code), deps, BASE));
    expect(inserted).toHaveLength(2);
    for (const h of inserted) expect((await s.deps.store.tokens.get(h))?.revokedAt).not.toBeNull();
  });
});

describe("registration hardening", () => {
  const evil = { client_name: "Claude", redirect_uris: ["https://evil.example/cb"] };

  it("allow-list: the two Claude callbacks and loopback http only", () => {
    for (const ok of [REDIRECT, "https://claude.com/api/mcp/auth_callback", "http://localhost:1234/cb", "http://127.0.0.1/x/y?z=1", "http://[::1]:8080/cb"]) expect(isAllowedRedirectUri(ok)).toBe(true);
    for (const bad of ["https://evil.example/cb", "https://claude.ai/other", "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai.evil.example/api/mcp/auth_callback", "https://www.claude.ai/api/mcp/auth_callback"]) expect(isAllowedRedirectUri(bad)).toBe(false);
  });
  it("spoof: https://evil.example/cb with client_name Claude is rejected; the owner can list extra hosts", async () => {
    const { deps } = setup();
    await expectGrantError(registerClient(evil, deps), "invalid_redirect_uri");
    await expectGrantError(registerClient({ ...evil, redirect_uris: [REDIRECT, "https://evil.example/cb"] }, deps), "invalid_redirect_uri");
    expect(parseExtraRedirectHosts(" My.Host.example, ,bad host,x/y ,other.example")).toEqual(["my.host.example", "other.example"]);
    const ok = await registerClient({ client_name: "Mine", redirect_uris: ["https://my.host.example/cb"] }, deps, { extraRedirectHosts: ["my.host.example"] });
    expect(ok.redirect_uris).toEqual(["https://my.host.example/cb"]);
    await expectGrantError(registerClient({ client_name: "Mine", redirect_uris: ["http://my.host.example/cb"] }, deps, { extraRedirectHosts: ["my.host.example"] }), "invalid_redirect_uri");
  });
  it("consent view: warning flag for hosts other than claude.ai / claude.com", async () => {
    const { deps } = setup();
    const r = await registerClient({ client_name: "Claude", redirect_uris: ["https://my.host.example/cb"] }, deps, { extraRedirectHosts: ["my.host.example"] });
    const check = await checkAuthorizeRequest(authParams(r.client_id, { redirect_uri: "https://my.host.example/cb" }), deps, BASE);
    expect(check.kind === "ok" && check.view).toMatchObject({ redirectHost: "my.host.example", trustedHost: false });
    const good = await register(deps);
    const g = await checkAuthorizeRequest(authParams(good.client_id), deps, BASE);
    expect(g.kind === "ok" && g.view.trustedHost).toBe(true);
    expect(isTrustedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isTrustedRedirectUri("http://localhost:3000/cb")).toBe(false);
  });
  it("per-IP limit: the 11th registration within an hour is refused (429) and does not leave a row; other IPs and later hours are fine", async () => {
    const { deps, clock } = setup();
    const reg = (ip: string) => registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] }, deps, { ipHash: ip.repeat(64).slice(0, 64) });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP_PER_HOUR; i++) await reg("a");
    await expect(reg("a")).rejects.toSatisfy((e: unknown) => e instanceof OAuthError && e.status === 429);
    expect((await deps.store.clients.list()).length).toBe(MAX_REGISTRATIONS_PER_IP_PER_HOUR);
    await reg("b");
    clock.t += REGISTRATION_WINDOW_MS + 1;
    await reg("a");
  });
  it("per-IP limit holds against a parallel burst (insert-first re-check)", async () => {
    const { deps } = setup();
    const res = await Promise.allSettled(Array.from({ length: 40 }, () => registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] }, deps, { ipHash: "c".repeat(64) })));
    expect(res.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(MAX_REGISTRATIONS_PER_IP_PER_HOUR);
    expect((await deps.store.clients.list()).length).toBeLessThanOrEqual(MAX_REGISTRATIONS_PER_IP_PER_HOUR);
  });
  it("cap counts only live apps: abandoned registrations older than 1 h do not block, apps with a token do count", async () => {
    const { deps, clock } = setup();
    for (let i = 0; i < MAX_CLIENTS; i++) await register(deps);
    await expectGrantError(register(deps), "invalid_client_metadata"); // all fresh
    clock.t += 61 * 60_000; // all abandoned now
    await register(deps);
    // an app that got a token stays counted forever
    const s = setup();
    const { client_id } = await register(s.deps);
    await exchangeToken(codeGrant(client_id, await getCode(s.deps, client_id)), s.deps, BASE);
    expect((await s.deps.store.clients.get(client_id))?.hasToken).toBe(true);
    s.clock.t += 24 * 3600_000;
    expect(await s.deps.store.clients.countLive(new Date(s.clock.t - 3600_000))).toBe(1);
  });
});
