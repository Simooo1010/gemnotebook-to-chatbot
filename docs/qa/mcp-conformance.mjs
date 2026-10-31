// MCP + OAuth conformance harness (TESTER 2). Runs the REAL official client (@modelcontextprotocol/sdk Client,
// StreamableHTTPClientTransport, OAuth helpers) headlessly against a local dev server, then probes details a strict
// client trips on. Findings are printed as PASS/FAIL/INFO lines and written (secrets redacted) to QA_OUT (JSON).
//
// Usage (synthetic secrets only):
//   .env.local: OWNER_PASSPHRASE, MASTER_SECRET (>=32), PUBLIC_BASE_URL=http://localhost:3200, CRON_SECRET
//   kill stale servers by PID, then `npx next dev --webpack -p 3200` (Turbopack dev showed an HMR reload loop under headless Chromium), then `node docs/qa/mcp-conformance.mjs`
// The consent page really redirects to https://claude.ai/...; we capture the Location of the /oauth/consent 303 and
// never follow it. Needs playwright (chromium) resolvable via require().
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sdkDir = new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url).href;
const { Client } = await import(sdkDir + "client/index.js");
const { StreamableHTTPClientTransport } = await import(sdkDir + "client/streamableHttp.js");
const authMod = await import(sdkDir + "client/auth.js");
const { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } = await import(sdkDir + "types.js");
const Ajv = require(new URL("../../node_modules/ajv", import.meta.url).pathname);

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3200";
const MCP = BASE + "/api/mcp";
const OUT = process.env.QA_OUT ?? "/tmp/mcp-conformance.json";
const CBS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const CB = CBS[0];
const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SECRET_VALUES = [env.OWNER_PASSPHRASE, env.MASTER_SECRET, env.CRON_SECRET].filter(Boolean);

// ---- reporting ---------------------------------------------------------------------------------------------
const results = [];
let failed = 0;
const redact = (s) => {
  let t = typeof s === "string" ? s : JSON.stringify(s);
  if (t === undefined) return "";
  t = t.replace(/nlm_(at|rt)_[A-Za-z0-9_-]+/g, "nlm_$1_<redacted>").replace(/([?&]code=)[A-Za-z0-9_-]{20,}/g, "$1<redacted>");
  for (const v of SECRET_VALUES) t = t.split(v).join("<secret>");
  return t;
};
function check(area, name, ok, detail = "") {
  if (!ok) failed++;
  results.push({ area, name, ok, detail: redact(detail).slice(0, 1500) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${name}${ok || !detail ? "" : "  -> " + redact(detail).slice(0, 400)}`);
}
function info(area, name, detail) {
  results.push({ area, name, ok: null, detail: redact(detail).slice(0, 1500) });
  console.log(`INFO  [${area}] ${name}  -> ${redact(detail).slice(0, 300)}`);
}
const b64u = (b) => Buffer.from(b).toString("base64url");
const hdrs = (r) => Object.fromEntries([...r.headers.entries()]);
const MCP_ACCEPT = "application/json, text/event-stream";

async function rpc(body, { token, headers = {}, url = MCP, method = "POST", raw = false } = {}) {
  const h = { "content-type": "application/json", accept: MCP_ACCEPT, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers: h, body: method === "GET" || method === "DELETE" ? undefined : raw ? body : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const datas = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    try { json = datas.length ? JSON.parse(datas[datas.length - 1]) : null; } catch { /* leave null */ }
  } else {
    try { json = JSON.parse(text); } catch { /* not json */ }
  }
  return { status: res.status, headers: hdrs(res), text, json };
}

// ---- OAuth provider for the real SDK -----------------------------------------------------------------------
class Provider {
  constructor(redirect = CB, name = "Claude") {
    this._redirect = redirect;
    this._name = name;
    this.info = undefined;
    this._tokens = undefined;
    this.verifier = undefined;
    this.authUrl = null;
    this.stateValue = "st_" + crypto.randomBytes(6).toString("hex");
  }
  get redirectUrl() { return this._redirect; }
  get clientMetadata() {
    return { client_name: this._name, redirect_uris: [this._redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return this.stateValue; }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this._tokens; }
  saveTokens(t) { this._tokens = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  invalidateCredentials(scope) { if (scope === "all" || scope === "tokens") this._tokens = undefined; }
}

// ---- browser: log in once, drive consent, capture the 303 Location -------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext();
let loggedIn = false;
async function ensureLogin(page, authorizeUrl) {
  if (loggedIn) return;
  await page.goto(authorizeUrl);
  await page.fill("#passphrase", env.OWNER_PASSPHRASE);
  await Promise.all([page.waitForURL(/\/oauth\/authorize/), page.click('button:has-text("Sign in")')]);
  loggedIn = true;
}
/** Opens the authorize URL in a real browser, signs in if needed, presses Approve/Deny; returns the consent response. */
async function consent(authorizeUrl, decision = "approve") {
  const page = await ctx.newPage();
  let resp = null;
  const csp = [];
  page.on("console", (m) => { if (/content security policy|form-action/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.url().endsWith("/oauth/consent")) resp = { status: r.status(), location: r.headers()["location"] ?? "" }; });
  try {
    if (!loggedIn) await ensureLogin(page, authorizeUrl);
    else await page.goto(authorizeUrl);
    const title = await page.title();
    const heading = await page.locator("h1").first().textContent().catch(() => "");
    await page.click(`button[value="${decision}"]`, { timeout: 5000 });
    for (let i = 0; i < 50 && !resp; i++) await page.waitForTimeout(100);
    return { resp, csp, title, heading };
  } finally {
    await page.close().catch(() => {});
  }
}
/** Raw authorize GET with the logged-in browser cookies, no redirect following. */
async function authorizeRaw(qs) {
  const r = await ctx.request.get(`${BASE}/oauth/authorize?${qs}`, { maxRedirects: 0 });
  return { status: r.status(), location: r.headers()["location"] ?? "", body: (await r.text()).slice(0, 4000) };
}
const pkce = () => { const v = b64u(crypto.randomBytes(48)); return { verifier: v, challenge: b64u(crypto.createHash("sha256").update(v).digest()) }; };

// Registration is limited to 10 per client IP per hour (Fix T2-2): every call presents its own x-forwarded-for unless a test pins one.
let ipSeq = 1000;
async function register(redirect_uris = [CB], extra = {}, ip = `10.77.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`) {
  const r = await fetch(BASE + "/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ client_name: "Claude", redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...extra }) });
  return { status: r.status, json: await r.json().catch(() => null), headers: hdrs(r) };
}
async function getCode({ clientId, redirect = CB, scope = "notebooklm", resource = MCP, state = "s" + crypto.randomBytes(4).toString("hex") }) {
  const p = pkce();
  const qs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", state });
  if (scope !== null) qs.set("scope", scope);
  if (resource !== null) qs.set("resource", resource);
  const c = await consent(`${BASE}/oauth/authorize?${qs}`);
  const loc = c.resp?.location ? new URL(c.resp.location) : null;
  return { ...p, state, code: loc?.searchParams.get("code") ?? null, loc, resp: c.resp, csp: c.csp };
}
const form = (o) => new URLSearchParams(o).toString();
async function token(body, { json = false, headers = {} } = {}) {
  const r = await fetch(BASE + "/oauth/token", {
    method: "POST",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", ...headers },
    body: json ? JSON.stringify(body) : form(body),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: r.status, headers: hdrs(r), json: j, text };
}

// =============================================================================================================
// 1. Full flow with the REAL SDK client
// =============================================================================================================
console.log("\n== 1. SDK client flow ==");
const provider = new Provider();
const rawLog = [];
const loggingFetch = async (input, init) => {
  const res = await fetch(input, init);
  rawLog.push({ method: init?.method ?? "GET", url: String(input), status: res.status, www: res.headers.get("www-authenticate") });
  return res;
};
let client = new Client({ name: "qa-sdk-client", version: "0.0.1" });
let transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: loggingFetch });
let unauthorized = false;
try { await client.connect(transport); } catch (e) { unauthorized = e?.name === "UnauthorizedError" || /unauthorized/i.test(String(e)); if (!unauthorized) info("flow", "unexpected connect error", String(e)); }
check("flow", "unauthenticated connect -> 401 -> SDK discovery -> redirectToAuthorization", unauthorized && !!provider.authUrl, JSON.stringify(rawLog));
const first = rawLog[0];
check("flow", "first request is 401 with WWW-Authenticate resource_metadata", first?.status === 401 && /resource_metadata="[^"]+"/.test(first.www ?? ""), JSON.stringify(first));
check("flow", "SDK registered a client via DCR", !!provider.info?.client_id, JSON.stringify(rawLog.map((r) => r.method + " " + r.url.replace(BASE, "") + " " + r.status)));
const au = provider.authUrl;
if (au) {
  const q = au.searchParams;
  check("flow", "authorization URL carries response_type=code, S256 challenge, resource, redirect_uri, state", q.get("response_type") === "code" && q.get("code_challenge_method") === "S256" && !!q.get("code_challenge") && q.get("resource") === MCP && q.get("redirect_uri") === CB && q.get("state") === provider.stateValue, au.toString());
  info("flow", "authorize URL scope param chosen by SDK", String(q.get("scope")));
  const c = await consent(au.toString(), "approve");
  check("flow", "consent page rendered in real browser (no CSP violation)", c.csp.length === 0 && /Allow/.test(c.heading ?? ""), JSON.stringify({ csp: c.csp, heading: c.heading }));
  const loc = c.resp?.location ? new URL(c.resp.location) : null;
  check("flow", "/oauth/consent -> 303 to the client's redirect URI with code and exact state", c.resp?.status === 303 && loc?.origin + loc?.pathname === CB && !!loc.searchParams.get("code") && loc.searchParams.get("state") === provider.stateValue, JSON.stringify(c.resp));
  info("flow", "iss parameter on callback (RFC 9207)", String(loc?.searchParams.get("iss")));
  if (loc?.searchParams.get("code")) {
    try {
      await transport.finishAuth(loc.searchParams.get("code"));
      check("flow", "SDK token exchange (PKCE + resource) succeeded", !!provider.tokens()?.access_token);
    } catch (e) { check("flow", "SDK token exchange (PKCE + resource) succeeded", false, String(e)); }
  }
}
const tk = provider.tokens();
if (tk) {
  check("token", "token response fields (SDK-parsed)", tk.token_type?.toLowerCase() === "bearer" && typeof tk.expires_in === "number" && !!tk.refresh_token && tk.scope === "notebooklm", JSON.stringify({ ...tk, access_token: "x", refresh_token: "x" }));
  client = new Client({ name: "qa-sdk-client", version: "0.0.1" });
  transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: loggingFetch });
  try {
    await client.connect(transport);
    check("flow", "initialize with real SDK client", true);
    info("flow", "negotiated", JSON.stringify({ proto: transport.protocolVersion, session: transport.sessionId ?? null, server: client.getServerVersion(), caps: client.getServerCapabilities(), instructions: client.getInstructions() ?? null }));
  } catch (e) { check("flow", "initialize with real SDK client", false, String(e)); }
}

let tools = [];
try {
  const lt = await client.listTools();
  tools = lt.tools;
  check("flow", "tools/list via SDK (pagination: nextCursor absent or handled)", tools.length > 0, `nextCursor=${lt.nextCursor}`);
  let cursor = lt.nextCursor;
  while (cursor) { const more = await client.listTools({ cursor }); tools.push(...more.tools); cursor = more.nextCursor; }
} catch (e) { check("flow", "tools/list via SDK", false, String(e)); }
try {
  const r = await client.callTool({ name: "accounts_list", arguments: {} });
  check("flow", "tools/call accounts_list via SDK", !!r.content?.length, JSON.stringify(r).slice(0, 400));
  info("flow", "accounts_list result", JSON.stringify(r).slice(0, 400));
} catch (e) { check("flow", "tools/call accounts_list via SDK", false, String(e)); }
try { await client.ping(); check("flow", "ping via SDK", true); } catch (e) { check("flow", "ping via SDK", false, String(e)); }

// ---- refresh rotation ---------------------------------------------------------------------------------------
console.log("\n== 2. Refresh rotation ==");
const clientInfo = provider.info;
const rt0 = tk?.refresh_token;
if (rt0 && clientInfo) {
  const prm = await (await fetch(BASE + "/.well-known/oauth-protected-resource/api/mcp")).json();
  const meta = await (await fetch(BASE + "/.well-known/oauth-authorization-server")).json();
  // with resource (SDK helper)
  let rotated = null;
  try { rotated = await authMod.refreshAuthorization(BASE, { metadata: meta, clientInformation: clientInfo, refreshToken: rt0, resource: new URL(prm.resource) }); } catch (e) { check("refresh", "SDK refreshAuthorization with resource", false, String(e)); }
  check("refresh", "SDK refreshAuthorization with resource -> new pair", !!rotated?.access_token && !!rotated?.refresh_token && rotated.refresh_token !== rt0, rotated ? "" : "null");
  check("refresh", "refresh response keeps scope (many clients read it)", rotated?.scope === "notebooklm", String(rotated?.scope));
  if (rotated) {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: rotated.access_token });
    check("refresh", "rotated access token works on /api/mcp", r.status === 200 && !!r.json?.result?.tools, `status ${r.status}`);
    // Fix T2-1: a retry inside the 20 s grace window gets a fresh pair and leaves the family intact.
    const retry = await token({ grant_type: "refresh_token", refresh_token: rt0, client_id: clientInfo.client_id });
    check("refresh", "retry of a just-rotated refresh token (grace window, 20 s) -> 200 with a fresh pair", retry.status === 200 && !!retry.json?.refresh_token && retry.json.refresh_token !== rotated.refresh_token, `${retry.status} ${retry.text}`);
    const both = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: rotated.access_token });
    check("refresh", "grace retry did not revoke the family: the first rotated access token still works", both.status === 200, `status ${both.status}`);
    await new Promise((r) => setTimeout(r, 21_000));
    const old = await token({ grant_type: "refresh_token", refresh_token: rt0, client_id: clientInfo.client_id });
    check("refresh", "late reuse (after the grace window) of a rotated refresh token -> 400 invalid_grant", old.status === 400 && old.json?.error === "invalid_grant", `${old.status} ${old.text}`);
    const afterTheft = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: rotated.access_token });
    check("refresh", "after late reuse the family's access token is revoked (theft detection)", afterTheft.status === 401, `status ${afterTheft.status}`);
    const kid = await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: clientInfo.client_id });
    check("refresh", "after late reuse the newest refresh token is dead", kid.status === 400, `status ${kid.status} ${kid.json?.error ?? ""}`);
  }
}

// =============================================================================================================
// 3. Fresh grant for raw protocol tests
// =============================================================================================================
console.log("\n== 3. Raw protocol ==");
const reg = await register();
check("register", "DCR 201 with client_id, redirect_uris, token_endpoint_auth_method none", reg.status === 201 && !!reg.json?.client_id && reg.json?.token_endpoint_auth_method === "none", JSON.stringify(reg.json));
info("register", "DCR response headers", JSON.stringify({ cc: reg.headers["cache-control"], pragma: reg.headers["pragma"], ct: reg.headers["content-type"] }));
const cid = reg.json.client_id;
const g = await getCode({ clientId: cid });
check("authorize", "consent -> code for fresh client", !!g.code, JSON.stringify(g.resp));
const tr = await token({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, client_id: cid, code_verifier: g.verifier, resource: MCP });
check("token", "authorization_code exchange 200", tr.status === 200 && !!tr.json?.access_token, `${tr.status} ${tr.text}`);
check("token", "fields: token_type Bearer, expires_in number, refresh_token, scope", tr.json?.token_type === "Bearer" && typeof tr.json?.expires_in === "number" && !!tr.json?.refresh_token && tr.json?.scope === "notebooklm", JSON.stringify({ ...tr.json, access_token: "x", refresh_token: "x" }));
check("token", "Cache-Control no-store + Pragma no-cache + JSON content-type", /no-store/.test(tr.headers["cache-control"] ?? "") && tr.headers["pragma"] === "no-cache" && /application\/json/.test(tr.headers["content-type"] ?? ""), JSON.stringify(tr.headers));
const AT = tr.json?.access_token;
const RT = tr.json?.refresh_token;

// code replay (uses its own code/family so the main AT/RT stay valid for later checks)
async function freshCode() { const x = await getCode({ clientId: cid }); return x; }
{
  const gr = await freshCode();
  const first1 = await token({ grant_type: "authorization_code", code: gr.code, redirect_uri: CB, client_id: cid, code_verifier: gr.verifier });
  const replay = await token({ grant_type: "authorization_code", code: gr.code, redirect_uri: CB, client_id: cid, code_verifier: gr.verifier });
  check("token", "code replay -> 400 invalid_grant", replay.status === 400 && replay.json?.error === "invalid_grant", `${replay.status} ${replay.text}`);
  const afterReplay = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: first1.json?.access_token });
  check("token", "code replay revokes tokens issued from that code (RFC 6749 4.1.2)", afterReplay.status === 401, `status ${afterReplay.status}`);
}

// token endpoint variants (fresh codes)
{
  const x = await freshCode();
  const r = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, client_id: cid, code_verifier: x.verifier }, { json: true });
  info("token", "JSON body to /oauth/token (non-standard)", `${r.status} ${r.text.slice(0, 200)}`);
  check("token", "JSON-encoded token request gets a clean 4xx OAuth error (not 5xx)", r.status >= 400 && r.status < 500 && !!r.json?.error, `${r.status} ${r.text}`);
}
{
  const x = await freshCode();
  const r = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, code_verifier: x.verifier });
  check("token", "missing client_id -> 401 invalid_client (public client sends client_id in body)", r.status === 401 && r.json?.error === "invalid_client", `${r.status} ${r.text}`);
  check("token", "invalid_client 401 includes a WWW-Authenticate challenge (RFC 6749 5.2)", !!r.headers["www-authenticate"], String(r.headers["www-authenticate"]));
}
{
  const x = await freshCode();
  const basic = "Basic " + Buffer.from(`${cid}:`).toString("base64");
  const r = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, code_verifier: x.verifier }, { headers: { authorization: basic } });
  info("token", "client_id only via Basic auth header (client_secret_basic style, empty secret)", `${r.status} ${r.json?.error ?? ""}`);
  const y = await freshCode();
  const r2 = await token({ grant_type: "authorization_code", code: y.code, redirect_uri: CB, client_id: cid, code_verifier: y.verifier, client_secret: "" });
  check("token", "empty client_secret param tolerated for public client", r2.status === 200, `${r2.status} ${r2.text}`);
}
{
  const x = await freshCode();
  const r = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, client_id: cid, code_verifier: x.verifier, resource: MCP + "/" });
  info("token", "resource with trailing slash", `${r.status} ${r.json?.error ?? ""}`);
  const y = await freshCode();
  const r2 = await token({ grant_type: "authorization_code", code: y.code, redirect_uri: CB, client_id: cid, code_verifier: y.verifier, resource: BASE });
  info("token", "resource = origin only", `${r2.status} ${r2.json?.error ?? ""}`);
  const z = await freshCode();
  const r3 = await token({ grant_type: "authorization_code", code: z.code, redirect_uri: CB, client_id: cid, code_verifier: z.verifier, resource: "https://evil.example/api/mcp" });
  check("token", "foreign resource -> invalid_target 400", r3.status === 400 && r3.json?.error === "invalid_target", `${r3.status} ${r3.text}`);
}
{
  const x = await freshCode();
  const r = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, client_id: cid, code_verifier: "A".repeat(43) });
  check("token", "wrong PKCE verifier -> invalid_grant", r.status === 400 && r.json?.error === "invalid_grant", `${r.status} ${r.text}`);
  const y = await freshCode();
  const r2 = await token({ grant_type: "authorization_code", code: y.code, redirect_uri: CBS[1], client_id: cid, code_verifier: y.verifier });
  check("token", "redirect_uri mismatch at token -> invalid_grant", r2.status === 400 && r2.json?.error === "invalid_grant", `${r2.status} ${r2.text}`);
  const z = await token({ grant_type: "password", client_id: cid, username: "a", password: "b" });
  check("token", "unsupported grant -> unsupported_grant_type", z.status === 400 && z.json?.error === "unsupported_grant_type", `${z.status} ${z.text}`);
  const w = await token({ grant_type: "authorization_code", client_id: "nlm_c_doesnotexist", code: "x", redirect_uri: CB, code_verifier: y.verifier });
  check("token", "unknown client -> 401 invalid_client", w.status === 401 && w.json?.error === "invalid_client", `${w.status} ${w.text}`);
  const e1 = await fetch(BASE + "/oauth/token", { method: "GET" });
  info("token", "GET /oauth/token", `${e1.status} allow=${e1.headers.get("allow")}`);
}

// refresh variants
{
  const r = await token({ grant_type: "refresh_token", refresh_token: RT, client_id: cid }); // without resource
  check("refresh", "refresh without resource -> 200 + new pair", r.status === 200 && !!r.json?.refresh_token && r.json?.scope === "notebooklm", `${r.status} ${JSON.stringify({ ...r.json, access_token: "x", refresh_token: "x" })}`);
  const r2 = await token({ grant_type: "refresh_token", refresh_token: r.json?.refresh_token ?? "nlm_rt_x", client_id: cid, resource: MCP });
  check("refresh", "refresh with resource -> 200", r2.status === 200, `${r2.status} ${r2.text.slice(0, 200)}`);
  const r3 = await token({ grant_type: "refresh_token", refresh_token: r2.json?.refresh_token ?? "nlm_rt_x", client_id: cid, scope: "notebooklm" });
  check("refresh", "refresh with scope=notebooklm -> 200", r3.status === 200, `${r3.status} ${r3.text.slice(0, 200)}`);
  const r4 = await token({ grant_type: "refresh_token", refresh_token: r3.json?.refresh_token ?? "nlm_rt_x", client_id: cid, scope: "other" });
  info("refresh", "refresh with a different scope", `${r4.status} ${r4.json?.error ?? ""}`);
  const r5 = await token({ grant_type: "refresh_token", refresh_token: "nlm_rt_nonexistent", client_id: cid });
  check("refresh", "unknown refresh token -> 400 invalid_grant", r5.status === 400 && r5.json?.error === "invalid_grant", `${r5.status} ${r5.text}`);
  const r6 = await token({ grant_type: "refresh_token", client_id: cid });
  check("refresh", "missing refresh_token -> 400", r6.status === 400, `${r6.status} ${r6.text}`);
}
// concurrent refresh (race): two parallel refreshes of the same token; exactly one may win
{
  const x = await freshCode();
  const t = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, client_id: cid, code_verifier: x.verifier });
  const [a, b] = await Promise.all([token({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid }), token({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid })]);
  check("refresh", "parallel double refresh of the same token (client retry race): both 200", a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
  for (const w of [a, b]) {
    if (!w.json?.access_token) continue;
    const wa = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: w.json.access_token });
    const wr = await token({ grant_type: "refresh_token", refresh_token: w.json.refresh_token, client_id: cid });
    check("refresh", "a duplicated/retried refresh request (network retry or two workers) must not kill either new session", wa.status === 200 && wr.status === 200, `access ${wa.status}, refresh ${wr.status} ${wr.json?.error ?? ""}`);
  }
}

// ---- token revoke -------------------------------------------------------------------------------------------
{
  const r = await fetch(BASE + "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: "nlm_rt_nope", client_id: cid }) });
  check("revoke", "revoke unknown token -> 200", r.status === 200, String(r.status));
}

// ---- MCP protocol-level ---------------------------------------------------------------------------------------
console.log("\n== 4. MCP wire protocol ==");
const init = (v) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ...(v === undefined ? {} : { protocolVersion: v }), capabilities: {}, clientInfo: { name: "qa", version: "1" } } });
for (const v of [...new Set(["2024-11-05", "2025-03-26", "2025-06-18", ...SUPPORTED_PROTOCOL_VERSIONS])]) {
  const r = await rpc(init(v), { token: AT });
  const got = r.json?.result?.protocolVersion;
  info("protocol", `initialize ${v}`, `status ${r.status} -> ${got} ct=${r.headers["content-type"]} session=${r.headers["mcp-session-id"] ?? "none"}`);
  check("protocol", `initialize with ${v} negotiates a version the SDK client accepts`, r.status === 200 && SUPPORTED_PROTOCOL_VERSIONS.includes(got), `${r.status} ${r.text.slice(0, 300)}`);
  if (v !== "2024-10-07") check("protocol", `initialize ${v}: server echoes the same version when it supports it`, got === v, `${v} -> ${got}`);
}
{
  const r = await rpc(init("1999-01-01"), { token: AT });
  check("protocol", "unknown future/legacy version -> server answers with a supported version (spec)", r.status === 200 && SUPPORTED_PROTOCOL_VERSIONS.includes(r.json?.result?.protocolVersion), `${r.status} ${r.text.slice(0, 300)}`);
  const r2 = await rpc(init(undefined), { token: AT });
  info("protocol", "initialize without protocolVersion", `${r2.status} ${r2.text.slice(0, 200)}`);
}
{
  const r = await rpc(init("2025-06-18"), { token: AT });
  const sv = r.json?.result;
  check("protocol", "initialize result has capabilities.tools, serverInfo.name/version", !!sv?.capabilities?.tools && !!sv?.serverInfo?.name && !!sv?.serverInfo?.version, JSON.stringify(sv ?? r.text).slice(0, 400));
  check("protocol", "stateless server does not advertise tools.listChanged:true (nothing can ever be notified)", sv?.capabilities?.tools?.listChanged !== true, JSON.stringify(sv?.capabilities));
  info("protocol", "initialize result", JSON.stringify(sv ?? r.text).slice(0, 500));
  const n = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { token: AT, headers: { "mcp-protocol-version": "2025-06-18" } });
  check("protocol", "notifications/initialized -> 202 with empty body", n.status === 202 && n.text === "", `${n.status} ${n.text.slice(0, 100)}`);
  const lt = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: AT, headers: { "mcp-protocol-version": "2025-06-18" } });
  check("protocol", "tools/list works statelessly (no session id needed)", lt.status === 200 && !!lt.json?.result?.tools, `${lt.status}`);
  const bad = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: AT, headers: { "mcp-protocol-version": "1999-01-01" } });
  check("protocol", "unsupported MCP-Protocol-Version header -> 400", bad.status === 400, `${bad.status} ${bad.text.slice(0, 200)}`);
  const sid = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: AT, headers: { "mcp-session-id": "bogus" } });
  info("protocol", "request carrying an unknown Mcp-Session-Id (stateless server)", `${sid.status} ${sid.text.slice(0, 160)}`);
  const lvl = await rpc({ jsonrpc: "2.0", id: 3, method: "logging/setLevel", params: { level: "info" } }, { token: AT });
  info("protocol", "logging/setLevel (not advertised)", `${lvl.status} ${lvl.text.slice(0, 160)}`);
  const unk = await rpc({ jsonrpc: "2.0", id: 4, method: "nope/nothing" }, { token: AT });
  check("protocol", "unknown method -> JSON-RPC -32601", unk.json?.error?.code === -32601, `${unk.status} ${unk.text.slice(0, 200)}`);
  for (const m of ["resources/list", "prompts/list", "resources/templates/list"]) {
    const x = await rpc({ jsonrpc: "2.0", id: 5, method: m }, { token: AT });
    info("protocol", `${m} (capability not advertised)`, `${x.status} ${x.text.slice(0, 160)}`);
  }
  const pj = await rpc("{not json", { token: AT, raw: true });
  check("protocol", "malformed JSON -> 400 JSON-RPC -32700, no stack", pj.status === 400 && pj.json?.error?.code === -32700 && !/\bat .*\(.*:\d+/.test(pj.text), `${pj.status} ${pj.text.slice(0, 200)}`);
  const emptyB = await rpc("", { token: AT, raw: true });
  info("protocol", "empty body", `${emptyB.status} ${emptyB.text.slice(0, 160)}`);
  const batch = await rpc([{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", id: 8, method: "tools/list" }], { token: AT, headers: { "mcp-protocol-version": "2025-03-26" } });
  info("protocol", "JSON-RPC batch under 2025-03-26 (batching allowed then)", `${batch.status} ${batch.text.slice(0, 160)}`);
  const ct = await rpc("{}", { token: AT, raw: true, headers: { "content-type": "text/plain" } });
  info("protocol", "text/plain content-type", `${ct.status} ${ct.text.slice(0, 160)}`);
  const acc = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { token: AT, headers: { accept: "application/json" } });
  info("protocol", "Accept: application/json only (spec requires both; SDK rejects)", `${acc.status} ${acc.text.slice(0, 160)}`);
  const acc2 = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { token: AT, headers: { accept: "*/*" } });
  info("protocol", "Accept: */* (spec: client MUST list both json+sse; SDK transport answers 406)", `${acc2.status}`);
  const acc3 = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { token: AT, headers: { accept: "text/event-stream" } });
  info("protocol", "Accept: text/event-stream only", `${acc3.status}`);
  const get = await rpc(null, { token: AT, method: "GET", headers: { accept: "text/event-stream" } });
  check("protocol", "authenticated GET /api/mcp -> 405 (SDK client tolerates 405 for the optional SSE stream)", get.status === 405, `${get.status} allow=${get.headers.allow} ${get.text.slice(0, 160)}`);
  info("protocol", "GET 405 headers", JSON.stringify({ allow: get.headers.allow, ct: get.headers["content-type"] }));
  const del = await rpc(null, { token: AT, method: "DELETE" });
  check("protocol", "authenticated DELETE /api/mcp -> 405/200/204 (stateless: nothing to terminate)", del.status === 405 || del.status === 200 || del.status === 204, `${del.status} ${del.text.slice(0, 160)}`);
  info("protocol", "DELETE status", `${del.status} allow=${del.headers.allow}`);
  for (const m of ["PUT", "PATCH"]) {
    const x = await fetch(MCP, { method: m, headers: { authorization: `Bearer ${AT}` } });
    info("protocol", `${m} /api/mcp`, `${x.status}`);
  }
  const head = await fetch(MCP, { method: "HEAD", headers: { authorization: `Bearer ${AT}` } });
  info("protocol", "HEAD /api/mcp", `${head.status}`);
}

// ---- 401 vs 403 semantics ----------------------------------------------------------------------------------
console.log("\n== 5. Auth semantics ==");
{
  const probe = async (name, tok, extra = {}) => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: tok, ...extra });
    return { name, r };
  };
  const cases = [
    await probe("no token", null),
    await probe("garbage token", "garbage"),
    await probe("nlm_at_ prefix but unknown", "nlm_at_" + "a".repeat(43)),
    await probe("refresh token used as access", RT),
    await probe("very long token", "nlm_at_" + "a".repeat(5000)),
  ];
  for (const { name, r } of cases) check("auth", `${name} -> 401 + WWW-Authenticate Bearer resource_metadata`, r.status === 401 && /^Bearer /.test(r.headers["www-authenticate"] ?? "") && /resource_metadata=/.test(r.headers["www-authenticate"] ?? ""), `${r.status} ${r.headers["www-authenticate"]}`);
  const basic = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { authorization: "Basic abc" } });
  info("auth", "Basic scheme", `${basic.status}`);
  const lower = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { authorization: `bearer ${AT}` } });
  check("auth", "lower-case 'bearer' scheme accepted (RFC 7235 case-insensitive)", lower.status === 200, `${lower.status}`);
  const qs = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { url: `${MCP}?access_token=${AT}` });
  check("auth", "token in query string rejected (bearer_methods_supported: header)", qs.status === 401, `${qs.status}`);
  const noScopeDesc = cases[0].r.headers["www-authenticate"] ?? "";
  info("auth", "WWW-Authenticate on 401 (no token)", noScopeDesc);
  check("auth", "no-token 401 carries no error=invalid_token (RFC 6750 3.1)", !/error="invalid_token"/.test(noScopeDesc), noScopeDesc);
}

// ---- CORS ----------------------------------------------------------------------------------------------------
console.log("\n== 6. CORS ==");
for (const origin of ["https://claude.ai", "https://claude.com"]) {
  for (const path of ["/api/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-authorization-server"]) {
    const reqH = "authorization,content-type,mcp-protocol-version,mcp-session-id,accept";
    const method = path.startsWith("/.well-known") ? "GET" : "POST";
    const r = await fetch(BASE + path, { method: "OPTIONS", headers: { origin, "access-control-request-method": method, "access-control-request-headers": reqH } });
    const allowH = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((s) => s.trim());
    const need = reqH.split(",").filter((h) => !["accept"].includes(h)); // accept is CORS-safelisted
    const missing = need.filter((h) => !allowH.includes(h) && !allowH.includes("*"));
    const okOrigin = r.headers.get("access-control-allow-origin") === origin;
    check("cors", `preflight ${origin} ${path}: 2xx + allow-origin echo + all requested headers allowed`, r.status < 300 && okOrigin && missing.length === 0, `${r.status} ao=${r.headers.get("access-control-allow-origin")} ah=${r.headers.get("access-control-allow-headers")} missing=${missing} am=${r.headers.get("access-control-allow-methods")}`);
  }
  const real = await fetch(MCP, { method: "POST", headers: { origin, "content-type": "application/json", accept: MCP_ACCEPT }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const expose = (real.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  check("cors", `actual 401 from ${origin} exposes WWW-Authenticate and Mcp-Session-Id`, expose.includes("www-authenticate") && expose.includes("mcp-session-id"), `expose=${expose}`);
  const ok = await fetch(MCP, { method: "POST", headers: { origin, authorization: `Bearer ${AT}`, "content-type": "application/json", accept: MCP_ACCEPT }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const e2 = (ok.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  check("cors", `actual 200 from ${origin} exposes Mcp-Session-Id (+allow-origin)`, ok.headers.get("access-control-allow-origin") === origin && e2.includes("mcp-session-id"), `ao=${ok.headers.get("access-control-allow-origin")} expose=${e2}`);
  const tokR = await fetch(BASE + "/oauth/token", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "refresh_token", client_id: cid, refresh_token: "nlm_rt_x" }) });
  check("cors", `actual /oauth/token error response carries allow-origin for ${origin}`, tokR.headers.get("access-control-allow-origin") === origin, String(tokR.headers.get("access-control-allow-origin")));
}
{
  const r = await fetch(MCP, { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "DELETE", "access-control-request-headers": "authorization,mcp-session-id" } });
  check("cors", "preflight for DELETE (session termination) lists DELETE in allow-methods", /DELETE/.test(r.headers.get("access-control-allow-methods") ?? ""), `am=${r.headers.get("access-control-allow-methods")}`);
  const evil = await fetch(MCP, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  check("cors", "foreign Origin gets no allow-origin", !evil.headers.get("access-control-allow-origin"), String(evil.headers.get("access-control-allow-origin")));
  const nullO = await fetch(MCP, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST" } });
  check("cors", "Origin: null gets no allow-origin", !nullO.headers.get("access-control-allow-origin"), "");
  const sub = await fetch(MCP, { method: "OPTIONS", headers: { origin: "https://www.claude.ai", "access-control-request-method": "POST" } });
  info("cors", "Origin https://www.claude.ai", String(sub.headers.get("access-control-allow-origin")));
}

// ---- Metadata ------------------------------------------------------------------------------------------------
console.log("\n== 7. Metadata ==");
{
  const prm = await (await fetch(BASE + "/.well-known/oauth-protected-resource/api/mcp")).json();
  const prm0 = await (await fetch(BASE + "/.well-known/oauth-protected-resource")).json();
  check("metadata", "PRM: resource == MCP URL exactly, authorization_servers[0] == issuer", prm.resource === MCP && prm.authorization_servers?.[0] === BASE, JSON.stringify(prm));
  check("metadata", "PRM root and path-suffixed variants agree", JSON.stringify(prm) === JSON.stringify(prm0));
  info("metadata", "PRM extras", `resource_name=${prm.resource_name} bearer=${prm.bearer_methods_supported} scopes=${prm.scopes_supported}`);
  const asm = await (await fetch(BASE + "/.well-known/oauth-authorization-server")).json();
  for (const f of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "response_types_supported", "grant_types_supported", "code_challenge_methods_supported", "token_endpoint_auth_methods_supported"]) check("metadata", `AS metadata has ${f}`, asm[f] !== undefined);
  check("metadata", "AS issuer has no trailing slash and equals PRM authorization server", asm.issuer === prm.authorization_servers[0]);
  const zodSchemas = await import(sdkDir + "shared/auth.js");
  const parsed = zodSchemas.OAuthMetadataSchema.safeParse(asm);
  check("metadata", "AS metadata passes the SDK's own OAuthMetadataSchema", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 300));
  const parsedP = zodSchemas.OAuthProtectedResourceMetadataSchema.safeParse(prm);
  check("metadata", "PRM passes the SDK's OAuthProtectedResourceMetadataSchema", parsedP.success, parsedP.success ? "" : JSON.stringify(parsedP.error.issues).slice(0, 300));
  info("metadata", "openid-configuration + path-suffixed AS variants", JSON.stringify(await Promise.all(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server/api/mcp", "/.well-known/openid-configuration/api/mcp", "/api/mcp/.well-known/openid-configuration"].map(async (p) => { const r = await fetch(BASE + p); return p + " -> " + r.status + " " + r.headers.get("content-type"); }))));
  const nf = await fetch(BASE + "/.well-known/openid-configuration");
  check("metadata", "unknown well-known path answers 404 (not 200/5xx)", nf.status === 404, String(nf.status));
  const post = await fetch(BASE + "/.well-known/oauth-authorization-server", { method: "POST" });
  info("metadata", "POST to metadata", String(post.status));
  const hostile = await fetch(BASE + "/.well-known/oauth-authorization-server", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
  const hj = await hostile.json().catch(() => null);
  check("metadata", "Host/X-Forwarded-Host spoofing does not change issuer (PUBLIC_BASE_URL wins)", hj?.issuer === BASE, JSON.stringify(hj?.issuer));
  const w = await fetch(MCP, { method: "POST", headers: { host: "evil.example", "x-forwarded-host": "evil.example", "content-type": "application/json" }, body: "{}" });
  check("metadata", "WWW-Authenticate resource_metadata ignores spoofed Host", !/evil\.example/.test(w.headers.get("www-authenticate") ?? ""), String(w.headers.get("www-authenticate")));
}

// ---- Registration / redirect URIs / authorize -----------------------------------------------------------------
console.log("\n== 8. Registration & authorize ==");
for (const cb of CBS) {
  const r = await register([cb]);
  check("register", `redirect URI ${cb} accepted`, r.status === 201, JSON.stringify(r.json));
}
for (const [name, uris] of [["http non-loopback", ["http://example.com/cb"]], ["fragment", ["https://claude.ai/cb#x"]], ["wildcard", ["https://*.claude.ai/cb"]], ["javascript:", ["javascript:alert(1)"]], ["empty array", []], ["not array", "https://claude.ai/cb"], ["userinfo", ["https://u:p@claude.ai/cb"]], ["6 URIs", Array.from({ length: 6 }, (_, i) => `https://claude.ai/cb${i}`)]]) {
  const r = await register(uris);
  check("register", `rejects redirect_uris: ${name}`, r.status === 400 && r.json?.error === "invalid_redirect_uri", `${r.status} ${JSON.stringify(r.json)}`);
}
{
  const loop = await register(["http://localhost:3118/callback", "http://127.0.0.1:9/cb"]);
  check("register", "loopback http redirect URIs accepted (native clients, MCP Inspector)", loop.status === 201, JSON.stringify(loop.json));
  const r = await register([CB], { scope: "notebooklm" });
  info("register", "DCR with scope field", `${r.status} scope-in-response=${r.json?.scope}`);
  const r1 = await register([CB], { token_endpoint_auth_method: "client_secret_post" });
  info("register", "DCR requesting client_secret_post (confidential)", `${r1.status} ${r1.json?.error}`);
  const r2 = await register([CB], { grant_types: ["authorization_code"] });
  info("register", "DCR grant_types only authorization_code", `${r2.status} grant_types=${JSON.stringify(r2.json?.grant_types)}`);
  const r3 = await register([CB], { client_uri: "https://claude.ai", logo_uri: "https://claude.ai/x.png", software_id: "x", contacts: ["a@b.c"] });
  check("register", "DCR tolerates unknown/optional RFC 7591 metadata (client_uri, logo_uri, software_id, contacts)", r3.status === 201, `${r3.status} ${JSON.stringify(r3.json)}`);
  const bad = await fetch(BASE + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  check("register", "malformed JSON -> 400 (not 5xx)", bad.status === 400, String(bad.status));
  const ct = await fetch(BASE + "/oauth/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_name=x" });
  info("register", "form-encoded DCR", String(ct.status));
  const dup = await Promise.all([register([CB]), register([CB])]);
  check("register", "two registrations get distinct client_ids", dup[0].json?.client_id !== dup[1].json?.client_id);
}
{
  // authorize error behaviour (needs owner session: browser context is logged in)
  const p = pkce();
  const base = { response_type: "code", client_id: cid, redirect_uri: CB, code_challenge: p.challenge, code_challenge_method: "S256", state: "xyz 1&2=3", scope: "notebooklm", resource: MCP };
  const q = (o) => new URLSearchParams({ ...base, ...o }).toString();
  const noNull = (o) => { const x = { ...base, ...o }; for (const k of Object.keys(x)) if (x[k] === null) delete x[k]; return new URLSearchParams(x).toString(); };
  const tests = [
    ["invalid scope", q({ scope: "bogus" }), "invalid_scope"],
    ["scope with extra token (openid)", q({ scope: "notebooklm openid" }), "invalid_scope"],
    ["unsupported response_type", q({ response_type: "token" }), "unsupported_response_type"],
    ["missing code_challenge", noNull({ code_challenge: null }), "invalid_request"],
    ["plain method", q({ code_challenge_method: "plain" }), "invalid_request"],
    ["missing method", noNull({ code_challenge_method: null }), "invalid_request"],
    ["foreign resource", q({ resource: "https://evil.example/api/mcp" }), "invalid_target"],
  ];
  for (const [name, qs, err] of tests) {
    const r = await authorizeRaw(qs);
    const loc = r.location ? new URL(r.location, BASE) : null;
    const redirected = r.status >= 300 && r.status < 400 && loc?.origin + loc?.pathname === CB;
    check("authorize", `${name} -> error redirect to client (RFC 6749 4.1.2.1) error=${err}, state echoed`, redirected && loc.searchParams.get("error") === err && loc.searchParams.get("state") === base.state, `${r.status} loc=${r.location} body=${r.body.slice(0, 200)}`);
  }
  const fatal = [
    ["unknown client", q({ client_id: "nlm_c_unknown" })],
    ["unregistered redirect_uri", q({ redirect_uri: "https://claude.ai/other" })],
    ["redirect_uri trailing slash differs", q({ redirect_uri: CB + "/" })],
    ["other claude host not registered", q({ redirect_uri: CBS[1] })],
    ["missing redirect_uri", noNull({ redirect_uri: null })],
  ];
  for (const [name, qs] of fatal) {
    const r = await authorizeRaw(qs);
    const loc = r.location ? new URL(r.location, BASE) : null;
    check("authorize", `${name} -> NO redirect to an untrusted URI (error page)`, !(loc && loc.origin !== BASE), `${r.status} ${r.location}`);
    info("authorize", `${name} status`, `${r.status} ${r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  const s = await authorizeRaw(noNull({ state: null, scope: null, resource: null }));
  info("authorize", "request without state/scope/resource (valid) status", `${s.status}`);
  const long = await authorizeRaw(q({ state: "x".repeat(2000) }));
  const ll = long.location ? new URL(long.location, BASE) : null;
  check("authorize", "state > 1024 chars -> error redirect without echoing the state", ll?.searchParams.get("error") === "invalid_request" && !ll.searchParams.get("state"), `${long.status} ${long.location.slice(0, 160)}`);
  // state handling end-to-end with awkward characters
  const awk = "a b&c=d/é?#é";
  const g2 = await getCode({ clientId: cid, state: awk });
  check("authorize", "state with spaces/&/=/unicode is echoed byte-exact", g2.loc?.searchParams.get("state") === awk, String(g2.loc?.searchParams.get("state")));
  const g3 = await getCode({ clientId: cid, scope: null, resource: null });
  check("authorize", "scope and resource omitted -> code still issued", !!g3.code, JSON.stringify(g3.resp));
  if (g3.code) {
    const t3 = await token({ grant_type: "authorization_code", code: g3.code, redirect_uri: CB, client_id: cid, code_verifier: g3.verifier });
    check("token", "no resource param at authorize or token -> still 200 with scope notebooklm", t3.status === 200 && t3.json?.scope === "notebooklm", `${t3.status} ${t3.text.slice(0, 120)}`);
  }
  // claude.com redirect end-to-end
  const rc = await register([CBS[1]]);
  const gc = await getCode({ clientId: rc.json.client_id, redirect: CBS[1] });
  check("authorize", "claude.com callback end-to-end: code delivered to claude.com URI", gc.loc?.origin + gc.loc?.pathname === CBS[1] && !!gc.code, JSON.stringify(gc.resp));
  // deny
  const dg = pkce();
  const den = await consent(`${BASE}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: CB, code_challenge: dg.challenge, code_challenge_method: "S256", state: "dn", scope: "notebooklm", resource: MCP })}`, "deny");
  const dl = den.resp?.location ? new URL(den.resp.location) : null;
  check("authorize", "Deny -> access_denied + state at the client", dl?.searchParams.get("error") === "access_denied" && dl.searchParams.get("state") === "dn", JSON.stringify(den.resp));
}
{
  // consent endpoint hardening
  const r = await fetch(BASE + "/oauth/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ decision: "approve", client_id: cid }) });
  check("authorize", "POST /oauth/consent without owner session/origin is refused (never issues a code)", r.status === 403 || r.status === 401, String(r.status));
  const o = await fetch(BASE + "/oauth/authorize?" + new URLSearchParams({ response_type: "code", client_id: cid }), { redirect: "manual" });
  info("authorize", "unauthenticated authorize GET", `${o.status} -> ${o.headers.get("location")}`);
}

// ---- Tools ---------------------------------------------------------------------------------------------------
console.log("\n== 9. Tools ==");
const EXPECTED = ["accounts_list", "notebooks_list", "notebook_create", "notebook_rename", "notebook_get", "notebook_summary", "source_add_url", "source_add_youtube", "source_add_text", "source_add_drive", "source_get_text", "source_get_guide", "studio_audio_create", "studio_video_create", "studio_status", "studio_download_link", "chat_ask"];
const names = tools.map((t) => t.name);
check("tools", `tools/list returns exactly the ${EXPECTED.length} expected tools`, EXPECTED.every((n) => names.includes(n)) && names.length === EXPECTED.length, `missing=${EXPECTED.filter((n) => !names.includes(n))} extra=${names.filter((n) => !EXPECTED.includes(n))}`);
check("tools", "no duplicate tool names", new Set(names).size === names.length);
const ajv = new (Ajv.default ?? Ajv)({ strict: false, allErrors: true });
let ajv2020 = null;
try { const A2 = require(new URL("../../node_modules/ajv/dist/2020.js", import.meta.url).pathname); ajv2020 = new (A2.default ?? A2)({ strict: false, allErrors: true }); } catch { /* optional */ }
function walk(node, path, issues, depth = 0) {
  if (node === null || typeof node !== "object") return;
  if (depth > 20) { issues.push(`${path}: nesting > 20`); return; }
  if ("$ref" in node) issues.push(`${path}: contains $ref ${node.$ref}`);
  if ("$defs" in node || "definitions" in node) issues.push(`${path}: contains $defs/definitions`);
  if (Array.isArray(node.enum) && node.enum.length === 0) issues.push(`${path}: empty enum`);
  if (node.type === "object" && node.properties && node.required) for (const r of node.required) if (!(r in node.properties)) issues.push(`${path}: required '${r}' not in properties`);
  if (node.default !== undefined && Array.isArray(node.enum) && !node.enum.includes(node.default)) issues.push(`${path}: default not in enum`);
  if (node.pattern) { try { new RegExp(node.pattern, "u"); } catch { issues.push(`${path}: pattern not valid as unicode regex ${node.pattern}`); } }
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) { if (v && typeof v === "object" && !("type" in v) && !("anyOf" in v) && !("oneOf" in v) && !("enum" in v) && !("const" in v) && !("allOf" in v)) issues.push(`${path}.${k}: no type`); walk(v, `${path}.${k}`, issues, depth + 1); }
  for (const key of ["items", "additionalProperties"]) if (node[key] && typeof node[key] === "object") walk(node[key], `${path}.${key}`, issues, depth + 1);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[key])) node[key].forEach((n, i) => walk(n, `${path}.${key}[${i}]`, issues, depth + 1));
}
for (const t of tools) {
  const issues = [];
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) issues.push("name pattern");
  if (!t.description || t.description.trim().length < 20) issues.push("description missing/short");
  if (t.description && t.description.length > 2000) issues.push(`description ${t.description.length} chars`);
  const s = t.inputSchema;
  if (!s || s.type !== "object") issues.push("inputSchema.type != object");
  else {
    walk(s, "input", issues);
    const { $schema: _omit, ...bare } = s;
    for (const [label, a] of [["draft-07", ajv], ["2020-12", ajv2020]]) if (a) { try { a.compile(bare); } catch (e) { issues.push(`ajv ${label} compile: ${String(e.message).slice(0, 120)}`); } }
    if (s.properties === undefined) issues.push("inputSchema.properties absent (some clients require it)");
    if (s.additionalProperties === undefined) info("tools", `${t.name}: additionalProperties unspecified`, "");
  }
  if (t.outputSchema) walk(t.outputSchema, "output", issues);
  const a = t.annotations;
  if (!a) issues.push("annotations missing");
  else {
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (typeof a[k] !== "boolean") issues.push(`annotation ${k} not boolean`);
    if (a.destructiveHint !== false) issues.push("destructiveHint != false");
    if (a.readOnlyHint === true && a.idempotentHint !== true) issues.push("readOnly but not idempotent");
    if (!t.title && !a.title) issues.push("no title");
  }
  check("tools", `${t.name}: schema/name/description/annotations valid`, issues.length === 0, issues.join("; "));
  info("tools", `${t.name} summary`, JSON.stringify({ desc: t.description?.length, required: s?.required, props: Object.keys(s?.properties ?? {}), annotations: a, title: t.title, $schema: s?.$schema, addl: s?.additionalProperties, hasOutput: !!t.outputSchema }));
}
// truthfulness: read-only tools must be readOnly; mutate tools must not claim readOnly
const MUTATING = ["notebook_create", "notebook_rename", "source_add_url", "source_add_youtube", "source_add_text", "source_add_drive", "studio_audio_create", "studio_video_create", "chat_ask"];
for (const t of tools) {
  const should = MUTATING.includes(t.name);
  check("tools", `${t.name}: readOnlyHint ${should ? "false (it writes/consumes quota)" : "true (read only)"}`, t.annotations?.readOnlyHint === !should, JSON.stringify(t.annotations));
}
const tsd = tools.find((t) => t.name === "studio_download_link");
info("tools", "studio_download_link annotations", JSON.stringify(tsd?.annotations));

// bad-argument calls (raw, so statuses and bodies are visible)
console.log("\n-- bad arguments --");
const BAD = [
  ["empty object", {}],
  ["null args", null],
  ["wrong types", { account: 5, notebookId: 7, title: [], limit: "x", cursor: {}, url: 1, question: false, text: {}, content: [] }],
  ["not uuid + huge", { notebookId: "not-a-uuid", title: "x".repeat(100000), url: "http://" + "a".repeat(5000), question: "q".repeat(100000), content: "c".repeat(300000) }],
  ["injection", { account: "'; DROP TABLE accounts;--", notebookId: "00000000-0000-0000-0000-000000000000", title: "\u0000‮<script>alert(1)</script>", url: "javascript:alert(1)", question: "${process.env.MASTER_SECRET} {{7*7}}" }],
  ["valid shape, no account configured", { notebookId: "00000000-0000-0000-0000-000000000000", sourceId: "00000000-0000-0000-0000-000000000001", artifactId: "00000000-0000-0000-0000-000000000002", title: "t", url: "https://example.com/", videoId: "dQw4w9WgXcQ", text: "x", content: "x", question: "q?", kind: "deep_dive", format: "brief", style: "auto", fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" }],
  ["unknown extra props + proto pollution", JSON.parse('{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"extra":"y"}')],
];
const leakRe = new RegExp("(" + SECRET_VALUES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + "|nlm_at_|nlm_rt_|\\bat [\\w.<>$]+ \\(|node_modules|webpack|\\.ts:\\d+|SUPABASE_SERVICE_ROLE)", "i");
let badCalls = 0;
for (const t of tools) {
  const problems = [];
  const detail = [];
  for (const [label, args] of BAD) {
    const r = await rpc({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: t.name, ...(args === null ? {} : { arguments: args }) } }, { token: AT });
    badCalls++;
    const res = r.json?.result;
    const isErr = res?.isError === true;
    const protoErr = !!r.json?.error;
    const noArgsOk = t.name === "accounts_list" && res && Array.isArray(res.content) && !isErr; // tool has no required args
    const clean = r.status === 200 && (isErr || protoErr || noArgsOk || (label.startsWith("valid shape") && res && Array.isArray(res.content)));
    if (!clean) problems.push(`${label}: status ${r.status} ${r.text.slice(0, 160)}`);
    if (leakRe.test(r.text)) problems.push(`${label}: leak pattern '${r.text.match(leakRe)?.[0]}'`);
    if (r.status >= 500) problems.push(`${label}: 5xx`);
    if (protoErr && !isErr) detail.push(`${label}: JSON-RPC error ${r.json.error.code}`);
    if (r.text.length > 4000) problems.push(`${label}: response ${r.text.length} bytes`);
    if (label.startsWith("valid shape")) detail.push(`valid-shape: ${(res?.content?.[0]?.text ?? r.text).slice(0, 140)}`);
    if (label === "empty object") detail.push(`empty: ${(res?.content?.[0]?.text ?? JSON.stringify(r.json?.error)).slice(0, 140)}`);
  }
  check("tools-bad-args", `${t.name}: bad arguments -> clean error, never 5xx/stack/secret`, problems.length === 0, problems.join(" | "));
  info("tools-bad-args", `${t.name} sample errors`, detail.join(" || "));
}
info("tools-bad-args", "total bad calls", String(badCalls));
{
  const r = await rpc({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }, { token: AT });
  info("tools-bad-args", "unknown tool", `${r.status} ${r.text.slice(0, 200)}`);
  check("tools-bad-args", "unknown tool -> JSON-RPC error or isError, not 5xx", r.status < 500 && (!!r.json?.error || r.json?.result?.isError), `${r.status} ${r.text.slice(0, 200)}`);
  const r2 = await rpc({ jsonrpc: "2.0", id: 52, method: "tools/call", params: "nope" }, { token: AT });
  check("tools-bad-args", "tools/call with non-object params -> JSON-RPC error", r2.status < 500 && !!r2.json?.error, `${r2.status} ${r2.text.slice(0, 200)}`);
  const r3 = await rpc({ jsonrpc: "2.0", id: 53, method: "tools/list", params: { cursor: "garbage" } }, { token: AT });
  info("tools-bad-args", "tools/list with garbage cursor", `${r3.status} ${r3.text.slice(0, 120)}`);
}

// ---- revoke effect on tokens -------------------------------------------------------------------------------
{
  const x = await getCode({ clientId: cid });
  const t = await token({ grant_type: "authorization_code", code: x.code, redirect_uri: CB, client_id: cid, code_verifier: x.verifier });
  const rv = await fetch(BASE + "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: t.json.refresh_token, client_id: cid }) });
  const after = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: t.json.access_token });
  info("revoke", "refresh-token revoke also kills the family's access token", `revoke ${rv.status}; access afterwards ${after.status}`);
  const rv2 = await fetch(BASE + "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: t.json.access_token, token_type_hint: "access_token" }) });
  check("revoke", "revoke accepts token_type_hint and no client_id (public client)", rv2.status === 200, String(rv2.status));
}

// ---- open registration -----------------------------------------------------------------------------------
{
  const evil = await register(["https://evil.example/cb"], { client_name: "Claude" });
  check("register", "redirect URIs restricted to the known Claude callbacks (claude.ai / claude.com) or loopback: arbitrary https hosts rejected", evil.status === 400, `${evil.status} accepted https://evil.example/cb as client_name "Claude"`);
  const p = pkce();
  if (evil.json?.client_id) {
    const c = await consent(`${BASE}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: evil.json.client_id, redirect_uri: "https://evil.example/cb", code_challenge: p.challenge, code_challenge_method: "S256", state: "x", scope: "notebooklm", resource: MCP })}`, "deny");
    info("register", "consent page for the spoofed client reached (owner sees heading)", String(c.heading));
  }
  // unauthenticated flood of registrations: the cap is global, so anyone can lock the real client out
  // (Fix T2-2) per-IP limit: the flooding address is cut off after 10, any other address (the real client) still registers.
  let n = 0, lastStatus = 0;
  for (let i = 0; i < 260; i++) { const r = await register([CB], {}, "198.51.100.200"); lastStatus = r.status; if (r.status !== 201) break; n++; }
  const legit = await register([CB]);
  check("register", "unauthenticated DCR flood is rate limited per IP (429 after 10) ...", n === 10 && lastStatus === 429, `${n} registrations accepted from one address, then ${lastStatus}`);
  check("register", "... and cannot lock out the real client (other address still registers)", legit.status === 201, `a legitimate registration now gets ${legit.status} ${JSON.stringify(legit.json)}`);
}

await browser.close();
writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), sdk: LATEST_PROTOCOL_VERSION, failed, results }, null, 1));
console.log(failed ? `\n${failed} check(s) FAILED (details in ${OUT})` : "\nall conformance checks passed");
process.exit(failed ? 1 : 0);
