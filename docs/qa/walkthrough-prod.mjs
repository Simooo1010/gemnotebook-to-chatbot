// PRODUCTION-MODE QA walkthrough: `next build` + `next start`, Supabase adapters (docs/qa/fake-supabase.mjs), `__Host-` Secure cookies,
// production CSP, fail-closed rules. Derived from docs/qa/walkthrough.mjs (dev, in-memory).
//
// Usage (docs/qa/run-prod.sh starts the emulator on :3410 and the app on :3300):
//   npm run build
//   .env.local (gitignored, SYNTHETIC): OWNER_PASSPHRASE, MASTER_SECRET (>= 32), CRON_SECRET, PUBLIC_BASE_URL=http://localhost:3300
//   .env.sbkey.local (gitignored):      FAKE_SB_KEY=<synthetic service key>
//   QA_LOGS=/tmp/qa-logs docs/qa/run-prod.sh && QA_LOGS=/tmp/qa-logs node docs/qa/walkthrough-prod.mjs
// Fresh emulator + server before every run (limiter / OAuth state is persistent in the emulator).
// Never prints secret values. Only the https://claude.ai callback request is stubbed (the 303 hop to it is real).
import { createRequire } from "node:module";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
let chromium;
for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) {
  try { ({ chromium } = require(p)); break; } catch {}
}
if (!chromium) throw new Error("playwright not found");

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3300";
const EMU = process.env.QA_EMU_URL ?? "http://127.0.0.1:3410";
const LOGS = process.env.QA_LOGS ?? "/tmp/qa-logs";
const readEnv = (f) => Object.fromEntries(readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const env = readEnv("../../.env.local");
const SB_KEY = readEnv("../../.env.sbkey.local").FAKE_SB_KEY;
const PASS = env.OWNER_PASSPHRASE;
const CRON = env.CRON_SECRET;
const CB = "https://claude.ai/api/mcp/auth_callback";

const results = [];
let step = "";
const check = (name, ok, detail = "") => {
  results.push({ step, name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}${!ok && detail ? ` -- ${String(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => { step = s; console.log(`\n== ${s}`); };
const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, `exception: ${String(e.message).split("\n")[0]}`); } };

// ---- secrets the app must never leak (synthetic) -------------------------------------------------------
const MARK = "SYNTHETICQAVALUE" + crypto.randomBytes(4).toString("hex");
const SECRETS = { passphrase: PASS, MASTER_SECRET: env.MASTER_SECRET, CRON_SECRET: CRON, supabase_service_key: SB_KEY, cookie_marker: "SYNTHETICQAVALUE" };
const liveTokens = []; // OAuth tokens: allowed only in the /oauth/token response body, nowhere else
const leaks = (text, { allowTokens = false } = {}) => {
  const hit = Object.entries(SECRETS).filter(([, v]) => v && text.includes(v)).map(([k]) => k);
  if (!allowTokens) for (const t of liveTokens) if (text.includes(t)) hit.push("oauth_token");
  return hit;
};
// Everything the browser/API ever received (bodies + headers), scanned at the end.
const received = [];
const record = (where, text) => received.push({ where, text: String(text) });

// ---- real-shaped cookie export: NO legacy SID (as the owner's real export) ----------------------------------------
const REAL_NAMES = ["__Secure-1PSID", "__Secure-3PSID", "SAPISID", "SSID", "__Secure-1PSIDTS", "OSID"];
const cookieExport = (names, marker = MARK) =>
  JSON.stringify(names.map((name, i) => ({
    domain: name.startsWith("__Secure") || name === "SID" ? ".google.com" : i % 2 ? ".google.com" : "accounts.google.com",
    name, value: `${marker}_${name}_${i}`, path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 2000000000 + i,
  })));
const cookieValues = (marker) => REAL_NAMES.map((n, i) => `${marker}_${n}_${i}`);

const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { redirect: "manual", ...init });
  return r;
};
const apiText = async (path, init) => {
  const r = await api(path, init);
  const text = await r.text();
  record(`api ${init?.method ?? "GET"} ${path.split("?")[0]}`, text + JSON.stringify([...r.headers]));
  return { r, text, status: r.status, headers: r.headers };
};
const emu = async (path, init) => (await fetch(EMU + path, init)).json();
const xff = (n) => ({ "x-forwarded-for": `10.1.${n >> 8}.${n & 255}` });
let ip = 10;

// ---- browser tracking (console errors, CSP violations, page errors, response capture) ---------------------------------
const consoleIssues = [];
function track(page, label) {
  page.on("console", (m) => {
    const t = m.text();
    if (["error", "warning"].includes(m.type()) || /content security policy|refused to|hydrat/i.test(t)) consoleIssues.push({ label, type: m.type(), text: t.slice(0, 300), url: page.url() });
  });
  page.on("pageerror", (e) => consoleIssues.push({ label, type: "pageerror", text: String(e.message).slice(0, 300), url: page.url() }));
  page.on("response", async (r) => {
    try {
      const u = r.url();
      if (!u.startsWith(BASE)) return;
      const ct = r.headers()["content-type"] ?? "";
      let body = "";
      if (/text|json|javascript/.test(ct)) body = await r.text().catch(() => "");
      record(`browser ${r.request().method()} ${u.replace(BASE, "").split("?")[0]} ${r.status()}`, body + JSON.stringify(r.headers()));
    } catch {}
  });
}
async function newCtx(browser, { colorScheme = "light", size = [1280, 800], login = false, label = "ctx" } = {}) {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: size[0], height: size[1] }, extraHTTPHeaders: xff(ip++) });
  await ctx.route("https://claude.ai/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>claude.ai stub</title>stub" }));
  const page = await ctx.newPage();
  track(page, label);
  if (login) await uiLogin(page);
  return { ctx, page };
}
async function uiLogin(page) {
  await page.goto(BASE + "/login");
  await page.fill("#passphrase", PASS);
  await Promise.all([page.waitForURL((u) => u.pathname !== "/login", { timeout: 15000 }), page.click('button:has-text("Sign in")')]);
}
const bodyLeaks = async (page) => leaks((await page.content()) + (await page.evaluate(() => document.body.innerText)));

// ---- PKCE / MCP ----------------------------------------------------------------------------------------------------------
const b64u = (b) => Buffer.from(b).toString("base64url");
const newPkce = () => { const verifier = b64u(crypto.randomBytes(48)); return { verifier, challenge: b64u(crypto.createHash("sha256").update(verifier).digest()) }; };
const authUrl = (clientId, challenge, state) =>
  `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256&scope=notebooklm&state=${state}&resource=${encodeURIComponent(BASE + "/api/mcp")}`;
async function mcp(token, body) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const { r, text, status } = await apiText("/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  let json = null;
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  try { json = JSON.parse(line ? line.slice(5) : text); } catch {}
  return { status, headers: r.headers, text, json };
}
// REAL redirect: the browser performs the 303 to claude.ai; we read the server's 303 Location from the response event and
// check that the browser actually navigated to the client (request to claude.ai observed, no CSP violation).
async function authorizeReal(browser, decision, { clientId, challenge, state }) {
  const { ctx, page } = await newCtx(browser, { label: "consent-" + decision });
  const csp = [];
  let consent = null;
  let toClient = null;
  page.on("console", (m) => { if (/content security policy|form-action/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.url().endsWith("/oauth/consent")) consent = { status: r.status(), location: r.headers()["location"] ?? "", headers: r.headers() }; });
  page.on("request", (rq) => { if (rq.url().startsWith("https://claude.ai/")) toClient = rq.url(); });
  await page.goto(BASE + authUrl(clientId, challenge, state));
  const landedLogin = new URL(page.url()).pathname === "/login" && (new URL(page.url()).searchParams.get("next") ?? "").startsWith("/oauth/authorize");
  await page.fill("#passphrase", PASS);
  await Promise.all([page.waitForURL(/\/oauth\/authorize/), page.click('button:has-text("Sign in")')]);
  const heading = await page.textContent("h1");
  const bodyText = await page.textContent("main");
  const pageLeaks = await bodyLeaks(page);
  await page.click(`button[value="${decision}"]`);
  for (let i = 0; i < 60 && !toClient && csp.length === 0; i++) await page.waitForTimeout(200);
  const left = new URL(page.url()).hostname !== new URL(BASE).hostname;
  await ctx.close();
  return { landedLogin, heading, bodyText, pageLeaks, consent, loc: consent?.location ? new URL(consent.location) : null, csp, toClient, left };
}

// ====================================================================================================================
const browser = await chromium.launch();
const issuedCookies = [];
try {
  // ---- 0 ---------------------------------------------------------------------------------------------------------------
  section("0 Prod-mode precondition");
  await guard("prod", async () => {
    const h = await apiText("/api/health");
    const j = JSON.parse(h.text);
    check("health ok and Supabase env present (running with emulator)", h.status === 200 && j.ok === true && j.env.SUPABASE_URL === true && j.env.SUPABASE_SERVICE_ROLE_KEY === true);
    check("health env values are booleans only", Object.values(j.env).every((v) => typeof v === "boolean"));
    check("health: no secrets", leaks(h.text).length === 0);
    check("x-powered-by absent", !h.headers.get("x-powered-by"));
    const home = await (await fetch(BASE + "/")).text();
    check("production build, not dev (no HMR / webpack-hmr, no next-devtools)", !/webpack-hmr|__nextjs_original-stack|nextjs-portal/.test(home));
  });

  // ---- 1 security headers on every route -----------------------------------------------------------------------------------
  section("1 Security headers on every route");
  const ROUTES = [
    ["GET", "/", "html"], ["GET", "/login", "html"], ["GET", "/vault", "redirect"], ["GET", "/does-not-exist", "html404"],
    ["GET", "/oauth/authorize?client_id=nope&redirect_uri=x&response_type=code", "consent"],
    ["GET", "/api/health", "api"], ["GET", "/api/health/deep", "api"], ["GET", "/api/cron/keepalive", "api"], ["GET", "/api/mcp", "api"],
    ["POST", "/api/mcp", "api"], ["GET", "/api/vault/accounts", "api"], ["POST", "/api/owner/login", "api"], ["POST", "/api/owner/logout", "api"],
    ["GET", "/api/media/not-a-token", "api"], ["GET", "/api/probe/google", "api"], ["POST", "/oauth/token", "oauth"], ["POST", "/oauth/register", "oauth"],
    ["POST", "/oauth/revoke", "oauth"], ["POST", "/oauth/consent", "oauth"],
    ["GET", "/.well-known/oauth-authorization-server", "wk"], ["GET", "/.well-known/oauth-protected-resource", "wk"], ["GET", "/.well-known/oauth-protected-resource/api/mcp", "wk"],
  ];
  const hdrFails = [];
  for (const [method, path, kind] of ROUTES) {
    const { r } = await apiText(path, { method, headers: { ...xff(ip++), "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    const h = (n) => r.headers.get(n) ?? "";
    const bad = [];
    if (!/nosniff/i.test(h("x-content-type-options"))) bad.push("nosniff");
    if (!/^DENY$/i.test(h("x-frame-options"))) bad.push("x-frame-options");
    if (!/no-referrer/.test(h("referrer-policy"))) bad.push("referrer-policy");
    if (path.startsWith("/api/") && !/no-store/.test(h("cache-control"))) bad.push("api no-store");
    if (["oauth", "wk"].includes(kind) && path.startsWith("/oauth/") && !/no-store/.test(h("cache-control"))) bad.push("oauth no-store");
    const csp = h("content-security-policy");
    if (["html", "html404"].includes(kind)) {
      if (!csp) bad.push("csp missing");
      if (/unsafe-eval/.test(csp)) bad.push("csp unsafe-eval");
      if (!/frame-ancestors 'none'/.test(csp)) bad.push("frame-ancestors");
      if ((csp.match(/default-src/g) ?? []).length !== 1) bad.push("csp duplicated");
      if (!/form-action 'self'(;|$)/.test(csp)) bad.push("form-action");
    }
    if (csp && /unsafe-eval/.test(csp)) bad.push("csp unsafe-eval (any route)");
    if (bad.length) hdrFails.push(`${method} ${path.split("?")[0]} [${r.status}]: ${bad.join(",")}`);
  }
  check(`security headers present on all ${ROUTES.length} routes`, hdrFails.length === 0, hdrFails.join(" | "));

  // ---- 2 login: __Host- Secure cookie -------------------------------------------------------------------------------------------
  section("2 Login gate (production cookie)");
  await guard("login cookie", async () => {
    const ipn = ip++;
    const lr = await apiText("/api/owner/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...xff(ipn) }, body: JSON.stringify({ passphrase: PASS }) });
    const sc = lr.r.headers.getSetCookie?.() ?? [];
    const c = sc[0] ?? "";
    check("login 200", lr.status === 200, `status ${lr.status} ${lr.text.slice(0, 80)}`);
    check("cookie is __Host-owner with Secure; HttpOnly; SameSite=Strict; Path=/; no Domain", /^__Host-owner=/.test(c) && /; Secure/.test(c) && /; HttpOnly/.test(c) && /SameSite=Strict/i.test(c) && /Path=\//.test(c) && !/Domain=/i.test(c), c.replace(/=[^;]+/, "=<v>"));
    check("session cookie max-age <= 12h", Number(/Max-Age=(\d+)/.exec(c)?.[1]) <= 43200);
    check("login response body has no cookie/secret", leaks(lr.text).length === 0);
  });
  await guard("browser login", async () => {
    const { ctx, page } = await newCtx(browser, { label: "login" });
    await page.goto(BASE + "/vault");
    check("/vault signed out lands on /login", new URL(page.url()).pathname === "/login");
    await page.fill("#passphrase", "definitely-not-the-passphrase");
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector("p.msg:not(:empty)");
    const msg = (await page.textContent("p.msg")).trim();
    check("wrong passphrase: generic error", /did not work/i.test(msg), msg);
    await page.fill("#passphrase", PASS);
    await Promise.all([page.waitForURL(/\/vault$/), page.click('button:has-text("Sign in")')]);
    check("correct passphrase lands on /vault (Chromium accepted Secure __Host- cookie on http://localhost)", new URL(page.url()).pathname === "/vault");
    const ck = (await ctx.cookies()).find((c) => c.name === "__Host-owner");
    check("browser stored __Host-owner (secure, httpOnly, strict, path=/)", !!ck && ck.secure && ck.httpOnly && ck.sameSite === "Strict" && ck.path === "/", JSON.stringify(ck && { ...ck, value: "<v>" }));
    await page.reload();
    check("session survives reload", new URL(page.url()).pathname === "/vault");
    await page.request.post(BASE + "/api/owner/logout", { headers: { origin: BASE } });
    await page.goto(BASE + "/vault");
    check("logout clears session (Max-Age=0 for __Host- cookie)", new URL(page.url()).pathname === "/login");
    await ctx.close();
  });
  await guard("limiter", async () => {
    const lip = xff(60001 % 65000);
    const key = crypto.createHash("sha256").update(lip["x-forwarded-for"]).digest("hex");
    const attempt = (p) => api("/api/owner/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...lip }, body: JSON.stringify({ passphrase: p }) });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt("wrong-" + i)).status);
    check("5 wrong attempts -> 401 each", codes.every((c) => c === 401), codes.join());
    const rows5 = (await emu("/__qa/tables")).login_attempts.filter((r) => r.key_hash === key).length;
    check("limiter persisted 5 attempt rows in login_attempts", rows5 === 5, `rows ${rows5}`);
    const sixth = await attempt(PASS);
    check("6th attempt (even with the CORRECT passphrase) -> 429 + Retry-After", sixth.status === 429 && Number(sixth.headers.get("retry-after")) > 0, `status ${sixth.status}`);
    const rows6 = (await emu("/__qa/tables")).login_attempts.filter((r) => r.key_hash === key).length;
    check("denied attempt removes its own row (lock not extended)", rows6 === 5, `rows ${rows6}`);
    const otherHdr = xff(ip++);
    const otherKey = crypto.createHash("sha256").update(otherHdr["x-forwarded-for"]).digest("hex");
    const other = await api("/api/owner/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...otherHdr }, body: JSON.stringify({ passphrase: PASS }) });
    check("a different client IP is unaffected", other.status === 200);
    const t = await emu("/__qa/tables");
    check("login_attempts store only 64-hex key hashes (no IP)", t.login_attempts.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash)) && !JSON.stringify(t.login_attempts).includes("10.1."));
    check("successful login deleted that client's attempt rows", t.login_attempts.filter((r) => r.key_hash === otherKey).length === 0);
  });

  // ---- 3 vault import / kill / revoke-all with real-shaped export ------------------------------------------------------------------------
  section("3 Vault import / kill / revoke (real-shaped cookies, no SID)");
    await guard("vault flow", async () => {
    const { ctx, page } = await newCtx(browser, { login: true, label: "vault" });
    await page.goto(BASE + "/vault");
    check("empty state shown", /No accounts yet/.test(await page.textContent("main")));
    const imp = async (label, json) => { await page.fill("#label", label); await page.fill("#cookies", json); await page.click('button:has-text("Connect account")'); await page.waitForTimeout(500); };
    await imp("QA bad", "{ not json");
    await page.waitForFunction(() => /cleared/.test(document.querySelector("form p.msg")?.textContent ?? ""));
    check("malformed JSON -> error, no account", /No accounts yet/.test(await page.textContent("main")));
    await imp("QA missing", cookieExport(REAL_NAMES.filter((n) => n !== "__Secure-1PSIDTS")));
    await page.waitForFunction(() => /cleared/.test(document.querySelector("form p.msg")?.textContent ?? ""));
    const msg = await page.textContent("form p.msg");
    check("missing cookie: names only __Secure-1PSIDTS", /Missing: __Secure-1PSIDTS\./.test(msg) && !msg.includes("SYNTHETICQAVALUE"), msg);
    await imp("QA personal", cookieExport(REAL_NAMES));
    await page.waitForSelector(".badge.active", { timeout: 10000 });
    check("REAL-shaped export (__Secure-1PSID, no SID) accepted -> Active", /QA personal/.test(await page.textContent("ul.list")));
    check("cookie-name count shown (6), no names/values", /6 cookie names stored/.test(await page.textContent("ul.list")));
    check("textarea cleared after import", (await page.inputValue("#cookies")) === "");
    check("page free of secrets after import", (await bodyLeaks(page)).length === 0 && !(await page.content()).includes("expirationDate"));
    const t1 = await emu("/__qa/tables");
    check("accounts row created in storage, status active, email_hash null/hash", t1.accounts.length === 1 && t1.accounts[0].status === "active");
    const env1 = t1.sessions[0]?.envelope ?? "";
    check("sessions.envelope present and is ciphertext (no plaintext cookie value / name / marker)", t1.sessions.length === 1 && env1.length > 40 && !env1.includes("SYNTHETICQAVALUE") && !/__Secure|SAPISID|OSID/.test(env1), env1.slice(0, 20));
    let plain = false;
    for (const enc of ["base64", "base64url", "hex"]) { try { if (Buffer.from(env1.replace(/[^A-Za-z0-9+/=_-]/g, ""), enc).toString("latin1").includes("SYNTHETICQAVALUE")) plain = true; } catch {} }
    check("envelope does not decode to plaintext (b64/hex)", !plain);
    let envJson = null; try { envJson = JSON.parse(env1); } catch {}
    check("envelope = JSON {v, kid, nonce, ct} (AES-256-GCM, 12-byte nonce, tag inside ct)", !!envJson && envJson.v === 1 && typeof envJson.kid === "string" && Buffer.from(envJson.nonce, "base64").length === 12 && Buffer.from(envJson.ct, "base64").length > 16, env1.slice(0, 40));
    console.log("      envelope shape:", env1.replace(/[A-Za-z0-9+/=_-]{8,}/g, (m) => `<${m.length}ch>`));

    await page.click('button[aria-label="Kill QA personal"]');
    await page.click('button:has-text("Yes, do it")');
    await page.waitForSelector(".badge.disabled");
    const t2 = await emu("/__qa/tables");
    check("kill: account disabled AND session row deleted in storage", t2.accounts[0].status === "disabled" && t2.sessions.length === 0);
    await imp("QA second", cookieExport(REAL_NAMES, MARK + "B"));
    await page.waitForSelector(".badge.active");
    await page.click('button[aria-label="Revoke all accounts"]');
    await page.click('button:has-text("Yes, do it")');
    await page.waitForFunction(() => document.querySelectorAll(".badge.disabled").length === 2);
    const t3 = await emu("/__qa/tables");
    check("revoke-all: every account disabled and no session rows left", t3.accounts.every((a) => a.status === "disabled") && t3.sessions.length === 0);
    check("page free of secrets after all steps", (await bodyLeaks(page)).length === 0);
    await ctx.close();
  });
  await guard("vault api edge", async () => {
    const { ctx } = await newCtx(browser, { login: true, label: "vault-api" });
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const h = { "content-type": "application/json", origin: BASE, cookie };
    const k1 = await apiText("/api/vault/accounts/not-a-uuid/kill", { method: "POST", headers: h });
    check("kill with non-uuid id -> 404 (not 500)", k1.status === 404, `status ${k1.status}`);
    const k2 = await apiText("/api/vault/accounts/00000000-0000-4000-8000-000000000000/kill", { method: "POST", headers: h });
    check("kill with unknown uuid -> 404", k2.status === 404, `status ${k2.status}`);
    const noOrigin = await apiText("/api/vault/revoke-all", { method: "POST", headers: { cookie } });
    check("state-changing POST without Origin -> 403", noOrigin.status === 403, `status ${noOrigin.status}`);
    const badOrigin = await apiText("/api/vault/revoke-all", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
    check("state-changing POST with foreign Origin -> 403", badOrigin.status === 403, `status ${badOrigin.status}`);
    const list = await apiText("/api/vault/accounts", { headers: { cookie } });
    check("accounts list never carries cookie data or envelope", leaks(list.text).length === 0 && !/envelope/.test(list.text));
    const dup = await apiText("/api/vault/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "x".repeat(61), json: cookieExport(REAL_NAMES, MARK + "L") }) });
    check("label > 60 chars -> 4xx (not a 500 from the storage CHECK)", dup.status >= 400 && dup.status < 500, `status ${dup.status} ${dup.text.slice(0, 100)}`);
    await ctx.close();
  });

  // ---- 4 OAuth with the REAL redirect ----------------------------------------------------------------------------------------------------
  section("4 OAuth (real consent redirect) + MCP");
  let clientId = null, accessToken = null, refreshToken = null;
  const pk = newPkce();
  const state = "st" + crypto.randomBytes(6).toString("hex");
  const tokenCall = (form) => apiText("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const exch = (code, v = pk.verifier) => tokenCall({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v, resource: BASE + "/api/mcp" });
  await guard("oauth", async () => {
    const meta = JSON.parse((await apiText("/.well-known/oauth-authorization-server")).text);
    check("AS metadata issuer = PUBLIC_BASE_URL, S256 only", meta.issuer === BASE && meta.code_challenge_methods_supported?.join() === "S256");
    const reg = await apiText("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    clientId = JSON.parse(reg.text).client_id;
    check("DCR 201 with client_id, stored in oauth_clients", reg.status === 201 && (await emu("/__qa/tables")).oauth_clients.some((c) => c.client_id === clientId), `status ${reg.status}`);

    const deny = await authorizeReal(browser, "deny", { clientId, challenge: pk.challenge, state });
    check("authorize signed out -> /login?next=/oauth/authorize...", deny.landedLogin);
    check("consent page: client name + redirect host, never sees Google cookies", /Allow .Claude. to use NotebookLM/.test(deny.heading) && /claude\.ai/.test(deny.bodyText) && /never sees your Google cookies/.test(deny.bodyText), deny.heading);
    check("consent page free of secrets", deny.pageLeaks.length === 0);
    check("Deny: 303 to client with error=access_denied + state, no code", deny.consent?.status === 303 && deny.loc?.searchParams.get("error") === "access_denied" && deny.loc.searchParams.get("state") === state && !deny.loc.searchParams.get("code"), JSON.stringify(deny.consent && { s: deny.consent.status }));
    check("Deny: browser really navigated to claude.ai, no CSP violation", !!deny.toClient && deny.csp.length === 0, deny.csp.join("|"));

    const ok = await authorizeReal(browser, "approve", { clientId, challenge: pk.challenge, state });
    check("Approve: 303 to exactly the registered redirect URI", ok.consent?.status === 303 && ok.loc.origin + ok.loc.pathname === CB);
    check("Approve: browser really navigated to claude.ai (REAL hop), no CSP violation", !!ok.toClient && ok.csp.length === 0, ok.csp.join("|"));
    check("Approve: callback has code + original state", !!ok.loc?.searchParams.get("code") && ok.loc.searchParams.get("state") === state);
    const code1 = ok.loc.searchParams.get("code");
    const bad = await exch(code1, "wrong-verifier-wrong-verifier-wrong-verifier-wrong-verifier");
    check("wrong PKCE verifier rejected (4xx)", bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
    const burned = await exch(code1);
    check("code is burned after a failed verifier attempt", burned.status >= 400 && burned.status < 500, `status ${burned.status}`);

    const ok2 = await authorizeReal(browser, "approve", { clientId, challenge: pk.challenge, state });
    const code2 = ok2.loc.searchParams.get("code");
    const [a, b] = await Promise.all([exch(code2), exch(code2)]);
    const wins = [a, b].filter((x) => x.status === 200);
    // Fix T4-1: after the replay is detected the family is dead. A 200 is possible only if the winner finished before the replay
    // was processed; its tokens are then revoked by the replay. If the replay was processed first the winner fails too (0 x 200).
    check("concurrent double-exchange of one code: at most one 200 (atomic claim via conditional UPDATE), the other is 4xx", wins.length <= 1 && [a, b].some((x) => x.status >= 400 && x.status < 500), `statuses ${a.status},${b.status}`);
    for (const w of wins) {
      const wj = JSON.parse(w.text);
      check("replayed code: the 200 winner's access token is dead afterwards (family revoked)", (await mcp(wj.access_token, { jsonrpc: "2.0", id: 9, method: "tools/list" })).status === 401);
      check("replayed code: the 200 winner's refresh token is dead afterwards", (await tokenCall({ grant_type: "refresh_token", refresh_token: wj.refresh_token, client_id: clientId })).status >= 400);
    }
    // (race statistics over many rounds: docs/qa/prod-extra.mjs)

    const ok3 = await authorizeReal(browser, "approve", { clientId, challenge: pk.challenge, state });
    const good = await exch(ok3.loc.searchParams.get("code"));
    const gj = JSON.parse(good.text);
    accessToken = gj.access_token; refreshToken = gj.refresh_token;
    liveTokens.push(accessToken, refreshToken);
    check("token exchange 200: nlm_at_ / nlm_rt_, Bearer, 3600s, no-store", good.status === 200 && /^nlm_at_/.test(accessToken) && /^nlm_rt_/.test(refreshToken) && gj.expires_in === 3600 && /no-store/.test(good.headers.get("cache-control") ?? ""));

    // storage inspection
    const t2 = await emu("/__qa/tables");
    const hexOk = (h) => /^[0-9a-f]{64}$/.test(h);
    check("oauth_codes.code_hash are 64-hex", t2.oauth_codes.length > 0 && t2.oauth_codes.every((c) => hexOk(c.code_hash)));
    check("oauth_tokens.token_hash are 64-hex", t2.oauth_tokens.length > 0 && t2.oauth_tokens.every((c) => hexOk(c.token_hash)));
    const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
    check("stored hash = sha256(token) for the issued access + refresh tokens", t2.oauth_tokens.some((x) => x.token_hash === sha(accessToken)) && t2.oauth_tokens.some((x) => x.token_hash === sha(refreshToken)));
    check("no plaintext token/code anywhere in storage", ![accessToken, refreshToken, code1, code2].some((s) => JSON.stringify(t2).includes(s)));
    check("oauth_codes used flag set for consumed codes", t2.oauth_codes.filter((c) => c.used).length >= 2);
  });

  await guard("mcp", async () => {
    const noTok = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const www = noTok.headers.get("www-authenticate") ?? "";
    check("/api/mcp without token -> 401 + WWW-Authenticate resource_metadata", noTok.status === 401 && /^Bearer/.test(www) && /resource_metadata="[^"]+oauth-protected-resource/.test(www), `status ${noTok.status}`);
    check("invalid bearer -> 401", (await mcp("nlm_at_not-a-real-token", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status === 401);
    const init = await mcp(accessToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } } });
    check("initialize ok", init.status === 200 && !!init.json?.result?.serverInfo, `status ${init.status} ${init.text.slice(0, 100)}`);
    const list = await mcp(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json?.result?.tools ?? []).map((t) => t.name);
    check(`tools/list returns the 17 tools (got ${names.length}), none destructive`, names.length === 17 && (list.json.result.tools).every((t) => t.annotations?.destructiveHint !== true));

    // active account for accounts_list
    const { ctx } = await newCtx(browser, { login: true, label: "mcp-import" });
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const imp = await apiText("/api/vault/accounts", { method: "POST", headers: { "content-type": "application/json", cookie, origin: BASE }, body: JSON.stringify({ label: "QA mcp account", json: cookieExport(REAL_NAMES, MARK + "M") }) });
    check("API import of real-shaped export -> 201", imp.status === 201, `status ${imp.status} ${imp.text.slice(0, 120)}`);
    issuedCookies.push(...cookieValues(MARK + "M"));
    await ctx.close();
    const call = await mcp(accessToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "accounts_list", arguments: {} } });
    check("accounts_list works with the issued token, lists the account, no cookie data", call.status === 200 && !call.json?.result?.isError && /QA mcp account/.test(call.text) && leaks(call.text, { allowTokens: false }).length === 0 && !/envelope|__Secure/.test(call.text), call.text.slice(0, 150));
    const nl = await mcp(accessToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "notebooks_list", arguments: {} } });
    check("notebooks_list (Google unreachable/synthetic cookies) returns a clean tool error, no leak", nl.status === 200 && leaks(nl.text).length === 0 && !/stack|at .*\.js|SUPABASE|127\.0\.0\.1:3410/.test(nl.text), nl.text.slice(0, 250));
    console.log("      notebooks_list result:", nl.text.replace(/\s+/g, " ").slice(0, 220));

    // rotation
    const refresh = (rt) => tokenCall({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId });
    const r1 = await refresh(refreshToken);
    const r1j = JSON.parse(r1.text);
    liveTokens.push(r1j.access_token, r1j.refresh_token);
    check("refresh -> new access + refresh", r1.status === 200 && r1j.refresh_token && r1j.refresh_token !== refreshToken && r1j.access_token !== accessToken, `status ${r1.status}`);
    check("new access token works", (await mcp(r1j.access_token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status === 200);
    const rt = (await emu("/__qa/tables")).oauth_tokens;
    check("old refresh token is marked revoked in storage after rotation", rt.find((x) => x.token_hash === crypto.createHash("sha256").update(refreshToken).digest("hex"))?.revoked === true);
    // Fix T2-1: an immediate retry of the rotated token (network retry / two workers) is inside the 20 s grace window: fresh pair, family intact.
    const retry = await refresh(refreshToken);
    const retryJ = JSON.parse(retry.text || "{}");
    if (retryJ.access_token) liveTokens.push(retryJ.access_token, retryJ.refresh_token);
    check("grace window: immediate retry of the rotated refresh token -> 200 with a fresh pair", retry.status === 200 && retryJ.refresh_token && retryJ.refresh_token !== r1j.refresh_token, `status ${retry.status}`);
    check("grace window: both pairs work", (await mcp(r1j.access_token, { jsonrpc: "2.0", id: 6, method: "tools/list" })).status === 200 && (await mcp(retryJ.access_token, { jsonrpc: "2.0", id: 6, method: "tools/list" })).status === 200);
    await new Promise((r) => setTimeout(r, 21_000));
    const old = await refresh(refreshToken);
    check("late reuse (after the 20 s window) of the rotated refresh token rejected (4xx)", old.status >= 400 && old.status < 500, `status ${old.status}`);
    check("late reuse revokes the family (theft detection): both pairs dead", (await mcp(r1j.access_token, { jsonrpc: "2.0", id: 6, method: "tools/list" })).status === 401 && (await mcp(retryJ.access_token, { jsonrpc: "2.0", id: 7, method: "tools/list" })).status === 401);
  });

  // ---- 5 cron/health ----------------------------------------------------------------------------------------------------------------------
  section("5 Cron and deep health (bearer)");
  await guard("cron", async () => {
    for (const path of ["/api/cron/keepalive", "/api/health/deep"]) {
      check(`${path} without bearer -> 401`, (await apiText(path)).status === 401);
      check(`${path} wrong bearer -> 401`, (await apiText(path, { headers: { authorization: "Bearer wrong-wrong-wrong" } })).status === 401);
    }
    const ka = await apiText("/api/cron/keepalive", { headers: { authorization: `Bearer ${CRON}` } });
    check("keepalive with CRON_SECRET -> 200 JSON, no leaks", ka.status === 200 && ka.text.startsWith("{") && leaks(ka.text).length === 0 && !/QA mcp account/.test(ka.text), `status ${ka.status} ${ka.text.slice(0, 120)}`);
    console.log("      keepalive body:", ka.text.slice(0, 260));
    const dp = await apiText("/api/health/deep", { headers: { authorization: `Bearer ${CRON}` } });
    check("deep health with CRON_SECRET -> JSON (200, or 503 because the synthetic account cannot reach Google: failing accounts turn the check red by design), no leaks, no names", (dp.status === 200 || dp.status === 503) && dp.text.startsWith("{") && leaks(dp.text).length === 0 && !/QA mcp account/.test(dp.text), `status ${dp.status} ${dp.text.slice(0, 120)}`);
    console.log("      deep body:", dp.text.slice(0, 260));
    const t = await emu("/__qa/tables");
    check("audit_log rows contain metadata only (tool/rpc_id/outcome), no secrets", t.audit_log.every((r) => Object.keys(r).sort().join() === "account_id,at,id,outcome,rpc_id,tool") && leaks(JSON.stringify(t.audit_log)).length === 0 && !/SYNTHETIC/.test(JSON.stringify(t.audit_log)));
    console.log("      audit_log rows:", t.audit_log.length, JSON.stringify(t.audit_log.slice(0, 4).map((r) => ({ tool: r.tool, rpc: r.rpc_id, outcome: r.outcome }))));
    console.log("      created_objects rows:", t.created_objects.length, " usage_counters rows:", t.usage_counters.length);
    console.log("      accounts statuses:", JSON.stringify(t.accounts.map((a) => a.status)));
  });

  // ---- 6 pages: console errors / CSP / hydration, consent page policy -----------------------------------------------------------------------------
  section("6 Pages: console errors, CSP, hydration");
  await guard("pages", async () => {
    const before = consoleIssues.length;
    const { ctx, page } = await newCtx(browser, { login: true, label: "pages" });
    const visit = async (path, label, waitSel) => {
      const resp = await page.goto(BASE + path);
      if (waitSel) await page.waitForSelector(waitSel, { timeout: 10000 });
      await page.waitForTimeout(400);
      return resp;
    };
    const home = await visit("/", "home");
    check("/ 200", home.status() === 200);
    await visit("/login", "login");
    const vault = await visit("/vault", "vault", ".badge");
    check("/vault signed in 200 with accounts", vault.status() === 200);
    // hydration proof: client JS must be live (Kill button opens a confirmation)
    await page.click('button[aria-label^="Revoke all accounts"]').catch(() => {});
    check("/vault client JS hydrated (confirm UI opens)", await page.isVisible('button:has-text("Yes, do it")').catch(() => false));
    await page.click('button:has-text("Cancel")').catch(() => {});
    const p = newPkce();
    const consent = await visit(authUrl(clientId, p.challenge, "s1"), "consent", 'button[value="approve"]');
    const ccsp = consent.headers()["content-security-policy"] ?? "";
    check("consent page: exactly one CSP, form-action allows https: redirect back, no unsafe-eval, frame-ancestors none", (ccsp.match(/default-src/g) ?? []).length === 1 && /form-action 'self' https:/.test(ccsp) && !/unsafe-eval/.test(ccsp) && /frame-ancestors 'none'/.test(ccsp), ccsp);
    check("consent page: nosniff + DENY + no-referrer", consent.headers()["x-content-type-options"] === "nosniff" && /deny/i.test(consent.headers()["x-frame-options"]) && /no-referrer/.test(consent.headers()["referrer-policy"]));
    check("consent page free of secrets", (await bodyLeaks(page)).length === 0);
    await visit(`/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${p.challenge}&code_challenge_method=S256`, "consent-error");
    await visit("/does-not-exist", "404");
    await ctx.close();
    const issues = consoleIssues.slice(before).filter((i) => !/claude\.ai/.test(i.text) && !/Failed to load resource.*(401|404|403|429|503)/.test(i.text));
    check("no console errors/warnings, CSP violations, hydration errors on any page", issues.length === 0, JSON.stringify(issues.slice(0, 3)));
    // 404 resource errors are expected for /does-not-exist itself; report them separately
    const all = consoleIssues.filter((i) => !/claude\.ai/.test(i.text));
    console.log("      console issues overall:", all.length, JSON.stringify(all.slice(0, 5)));
  });

  // ---- 7 storage failure behaviour (fail closed, no leaks) ------------------------------------------------------------------------------------------
  section("7 Storage outage: fail closed, clean errors");
  await guard("faults", async () => {
    const fault = (o) => fetch(EMU + "/__qa/fault", { method: "POST", body: JSON.stringify(o) });
    await fault({ table: "login_attempts", status: 503, times: 1 });
    const l = await apiText("/api/owner/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...xff(ip++) }, body: JSON.stringify({ passphrase: PASS }) });
    check("login with limiter store down -> 503 storage_unavailable (fail closed; Fix T4-2: not a 429 rate-limit answer)", l.status === 503 && /storage_unavailable/.test(l.text), `status ${l.status}`);
    check("...and no cookie issued", !(l.r.headers.getSetCookie?.() ?? []).some((c) => /__Host-owner=[^;]+/.test(c)));
    console.log("      login-with-store-down status:", l.status, l.text.slice(0, 100));
  });
} finally {
  await browser.close();
}

// ---- 8 final secret scan ---------------------------------------------------------------------------------------------------------------------------
section("8 Secret scan: responses, server logs, emulator log");
await guard("scan", async () => {
  const bad = [];
  for (const { where, text } of received) {
    const allowTok = /\/oauth\/token/.test(where);
    const h = leaks(text, { allowTokens: allowTok });
    // the owner session cookie value may appear in login Set-Cookie only; cookie export markers must never appear
    if (h.length) bad.push(`${where}: ${h.join(",")}`);
  }
  check(`no secret in any of ${received.length} captured responses (bodies + headers)`, bad.length === 0, bad.slice(0, 5).join(" | "));
  const serverLog = existsSync(`${LOGS}/server.log`) ? readFileSync(`${LOGS}/server.log`, "utf8") : "";
  check("server stdout/stderr readable", serverLog.length > 0, `${LOGS}/server.log`);
  const sl = leaks(serverLog);
  const slCookie = [...cookieValues(MARK), ...cookieValues(MARK + "B"), ...issuedCookies].some((v) => serverLog.includes(v));
  check("server log: no passphrase / MASTER_SECRET / CRON_SECRET / service key / cookie values / OAuth tokens", sl.length === 0 && !slCookie, sl.join(","));
  const log = await emu("/__qa/log");
  const logText = JSON.stringify(log);
  const el = leaks(logText);
  const elCookie = [...cookieValues(MARK), ...cookieValues(MARK + "B"), ...issuedCookies].some((v) => logText.includes(v));
  check(`emulator request log (${log.length} requests, full bodies): no secret / cookie value / plaintext token`, el.length === 0 && !elCookie, el.join(","));
  const t = await emu("/__qa/tables");
  const tl = leaks(JSON.stringify(t));
  check("storage tables: no secret / cookie value / plaintext token anywhere", tl.length === 0, tl.join(","));
  const rest = log.filter((r) => r.status !== 503 && (r.status >= 500 || r.status === 400 || r.status === 409 || r.status === 406));
  console.log("      emulator requests with error statuses:", rest.length, JSON.stringify(rest.slice(0, 6).map((r) => `${r.method} ${r.path}${r.query.slice(0, 50)} -> ${r.status}`)));
  check("app never triggered a PostgREST 4xx/5xx in normal operation (schema/filter/type mismatches)", rest.length === 0, JSON.stringify(rest.slice(0, 4).map((r) => `${r.method} ${r.path}${r.query.slice(0, 60)} -> ${r.status}`)));
  check("every emulator request carried the apikey header", log.every((r) => r.headers.apikey === "<present>" && r.headers.authorization === "<present>"));
  const nofilter = log.filter((r) => ["PATCH", "DELETE"].includes(r.method) && !r.query);
  check("no PATCH/DELETE without a filter was sent", nofilter.length === 0);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed; ${consoleIssues.length} console issues recorded`);
writeFileSync(new URL("./results-prod.json", import.meta.url), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
