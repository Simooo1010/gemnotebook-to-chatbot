// Final QA walkthrough (WORKFLOW gates 4 + 5) against a locally running dev server with in-memory adapters.
//
// Usage (see docs/qa/REPORT.md):
//   1. write a gitignored .env.local with SYNTHETIC values: OWNER_PASSPHRASE, MASTER_SECRET (>= 32 chars),
//      PUBLIC_BASE_URL=http://localhost:3000, CRON_SECRET
//   2. start a FRESH server:  npx next dev -p 3000   (state is in memory; restart before every re-run)
//   3. node docs/qa/walkthrough.mjs
//
// Logs PASS/FAIL per check. Secrets (passphrase, cron secret, tokens, cookie values) are never printed.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PASS = env.OWNER_PASSPHRASE;
const CRON = env.CRON_SECRET;

const results = [];
let currentStep = "";
const check = (name, ok, detail = "") => {
  results.push({ step: currentStep, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${currentStep}] ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
};
const section = (s) => {
  currentStep = s;
  console.log(`\n== ${s}`);
};
const guard = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, `exception: ${String(e.message).split("\n")[0]}`);
  }
};

// Synthetic values only. Each marker is searched for in everything the app sends back.
const MARK = "SYNTHETICQAVALUE" + crypto.randomBytes(4).toString("hex");
const cookieExport = (names, marker = MARK) =>
  JSON.stringify(
    names.map((name, i) => ({
      domain: name.startsWith("__Secure") || name === "SID" ? ".google.com" : i % 2 ? ".google.com" : "accounts.google.com",
      name,
      value: `${marker}_${name}_${i}`,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: 2000000000 + i,
    })),
  );
const FULL_NAMES = ["SID", "__Secure-1PSIDTS", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"];

const api = (path, init = {}) => fetch(BASE + path, { redirect: "manual", ...init });
const xff = (n) => ({ "x-forwarded-for": `10.0.${n >> 8}.${n & 255}` });
let ipCounter = 10;

async function newCtx(browser, { colorScheme = "light", size = [1280, 800], login = false } = {}) {
  const ctx = await browser.newContext({
    colorScheme,
    viewport: { width: size[0], height: size[1] },
    extraHTTPHeaders: xff(ipCounter++),
  });
  const page = await ctx.newPage();
  if (login) {
    const r = await ctx.request.post(BASE + "/api/owner/login", { data: { passphrase: PASS }, headers: { origin: BASE } });
    if (!r.ok()) throw new Error("login failed in newCtx: " + r.status());
  }
  return { ctx, page };
}

async function importViaUi(page, label, json) {
  await page.fill("#label", label);
  await page.fill("#cookies", json);
  await page.click('button:has-text("Connect account")');
  await page.waitForTimeout(400);
}

// ---- contrast helpers -------------------------------------------------------------------------
const CONTRAST_JS = () => {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, bot) => ({
    r: top.r * top.a + bot.r * (1 - top.a),
    g: top.g * top.a + bot.g * (1 - top.a),
    b: top.b * top.a + bot.b * (1 - top.a),
    a: 1,
  });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a === 1) break;
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const root = parse(getComputedStyle(document.body).backgroundColor);
    if (root && root.a === 1) acc = root;
    for (const c of stack.reverse()) acc = over(c, acc);
    return acc;
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const sel = "body,h1,h2,p,label,.meta,.msg,.okmsg,button,input:not([type=hidden]),textarea,.badge,a,code,.steps li,strong,.card";
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    // only elements that directly own text, or form controls
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const isControl = /^(BUTTON|INPUT|TEXTAREA)$/.test(el.tagName);
    if (!ownText && !isControl && el !== document.body) continue;
    if (el.disabled) continue;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    const bg = bgOf(el);
    const f = over(fg, bg);
    const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x);
    out.push({
      el: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : ""),
      text: (el.value && el.type !== "password" ? "" : (el.textContent || "").trim()).slice(0, 24),
      ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100,
    });
    // outline/border of controls vs page is a non-text contrast (3:1); report border vs background for inputs
  }
  return out;
};

const failures = [];
async function assertPage(page, label, { phone }) {
  if (phone) {
    const w = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
    check(`no horizontal scroll (${label})`, w.sw <= w.iw, `scrollWidth ${w.sw} > innerWidth ${w.iw}`);
  }
  const rows = await page.evaluate(CONTRAST_JS);
  const bad = rows.filter((r) => r.ratio < 4.5);
  check(`contrast >= 4.5 for ${rows.length} text elements (${label})`, bad.length === 0, JSON.stringify(bad.slice(0, 4)));
  if (bad.length) failures.push({ label, bad });
}

async function shot(page, name, theme, sizeName) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }); // dev-only indicator, not part of the app
  const file = `${SHOTS}${name}-${theme}-${sizeName}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const COMBOS = [
  ["light", "phone", [390, 844]],
  ["dark", "phone", [390, 844]],
  ["light", "desktop", [1280, 800]],
  ["dark", "desktop", [1280, 800]],
];
let shotCount = 0;
async function forEachCombo(browser, { login }, fn) {
  for (const [theme, sizeName, size] of COMBOS) {
    const { ctx, page } = await newCtx(browser, { colorScheme: theme, size, login });
    await guard(`${theme}/${sizeName}`, () => fn(page, theme, sizeName, sizeName === "phone"));
    await ctx.close();
  }
}
async function snap(page, name, theme, sizeName, phone) {
  await page.waitForTimeout(150);
  await shot(page, name, theme, sizeName);
  shotCount++;
  await assertPage(page, `${name} ${theme} ${sizeName}`, { phone });
}

// ---- PKCE ---------------------------------------------------------------------------------------
const b64u = (b) => Buffer.from(b).toString("base64url");
const newPkce = () => {
  const verifier = b64u(crypto.randomBytes(48));
  return { verifier, challenge: b64u(crypto.createHash("sha256").update(verifier).digest()) };
};
const CB = "https://claude.ai/api/mcp/auth_callback";

async function authorizeInBrowser(browser, decision, { clientId, challenge, state }) {
  const { ctx, page } = await newCtx(browser);
  let captured = null;
  // The consent POST answers 303 to the client's redirect URI (claude.ai, unreachable here): read its Location.
  await ctx.route("**/oauth/consent", async (route) => {
    const resp = await route.fetch({ maxRedirects: 0 });
    captured = resp.headers()["location"] ?? `status:${resp.status()}`;
    await route.fulfill({ status: 200, contentType: "text/plain", body: "captured" });
  });
  const url =
    `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CB)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&scope=notebooklm&state=${state}&resource=${encodeURIComponent(BASE + "/api/mcp")}`;
  await page.goto(BASE + url);
  const landedLogin = new URL(page.url()).pathname === "/login" && new URL(page.url()).searchParams.get("next")?.startsWith("/oauth/authorize");
  await page.fill("#passphrase", PASS);
  await Promise.all([page.waitForURL(/\/oauth\/authorize/), page.click('button:has-text("Sign in")')]);
  const heading = await page.textContent("h1");
  const bodyText = await page.textContent("main");
  await page.click(`button[value="${decision}"]`).catch(() => {});
  await page.waitForTimeout(800);
  await ctx.close();
  return { landedLogin, heading, bodyText, captured };
}

// ---- MCP ----------------------------------------------------------------------------------------
async function mcp(token, body) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await api("/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  try {
    json = JSON.parse(line ? line.slice(5) : text);
  } catch {}
  return { status: r.status, headers: r.headers, text, json };
}

// ====================================================================================================
const browser = await chromium.launch();
try {
  // ---- 1 ------------------------------------------------------------------------------------------
  section("1 Home and health");
  await guard("home", async () => {
    const { ctx, page } = await newCtx(browser);
    const resp = await page.goto(BASE + "/");
    check("GET / renders 200", resp.status() === 200);
    check("home says service is running", /running/i.test(await page.textContent("body")));
    await ctx.close();
  });
  await guard("health", async () => {
    const r = await api("/api/health");
    const j = await r.json();
    check("/api/health 200 ok:true", r.status === 200 && j.ok === true);
    check("health env values are all booleans", Object.values(j.env).every((v) => typeof v === "boolean"));
    const s = JSON.stringify(j);
    check("health never contains secrets", ![PASS, CRON, env.MASTER_SECRET].some((x) => s.includes(x)));
    check("health reports MASTER_SECRET/CRON_SECRET/PUBLIC_BASE_URL set", j.env.MASTER_SECRET && j.env.CRON_SECRET && j.env.PUBLIC_BASE_URL);
    check("health no-store", /no-store/.test(r.headers.get("cache-control") ?? ""));
  });

  // ---- 2 ------------------------------------------------------------------------------------------
  section("2 Login gate");
  await guard("signed-out vault", async () => {
    const { ctx, page } = await newCtx(browser);
    await page.goto(BASE + "/vault");
    check("/vault signed out lands on /login", new URL(page.url()).pathname === "/login");
    await page.fill("#passphrase", "definitely-not-the-passphrase");
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector("p.msg:not(:empty)");
    const msg = (await page.textContent("p.msg")).trim();
    check("wrong passphrase: generic error only", /did not work/i.test(msg) && !/passphrase|wrong|incorrect|invalid/i.test(msg.replace(/did not work/i, "")), msg);
    check("still on /login", new URL(page.url()).pathname === "/login");
    check("passphrase field cleared after failure", (await page.inputValue("#passphrase")) === "");
    await page.fill("#passphrase", PASS);
    await Promise.all([page.waitForURL(/\/vault$/), page.click('button:has-text("Sign in")')]);
    check("correct passphrase lands on /vault", new URL(page.url()).pathname === "/vault");
    await ctx.close();
  });

  // Gate 5 phase A: login + empty vault screens (before any account exists)
  section("6a Screenshots: login and empty vault");
  await forEachCombo(browser, { login: false }, async (page, theme, sz, phone) => {
    await page.goto(BASE + "/login");
    await snap(page, "login-default", theme, sz, phone);
    await page.fill("#passphrase", "x-wrong-x");
    await page.click('button:has-text("Sign in")');
    await page.waitForFunction(() => document.querySelector("p.msg")?.textContent.trim());
    await snap(page, "login-error", theme, sz, phone);
  });
  await forEachCombo(browser, { login: true }, async (page, theme, sz, phone) => {
    await page.goto(BASE + "/vault");
    check(`vault empty state text (${theme}/${sz})`, /No accounts yet/.test(await page.textContent("main")));
    await snap(page, "vault-empty", theme, sz, phone);
    await page.fill("#label", "Sample account");
    await page.fill("#cookies", "{ not json");
    await page.click('button:has-text("Connect account")');
  await page.waitForTimeout(400);
    await page.waitForFunction(() => /cleared/.test(document.querySelector("form p.msg")?.textContent ?? ""));
    await snap(page, "vault-import-error", theme, sz, phone);
  });

  // ---- 3 ------------------------------------------------------------------------------------------
  section("3 Vault import / kill / revoke");
  await guard("vault flow", async () => {
    const { ctx, page } = await newCtx(browser, { login: true });
    await page.goto(BASE + "/vault");
    check("empty state shown", /No accounts yet/.test(await page.textContent("main")));
    check("no connected apps yet", /No apps connected/.test(await page.textContent("main")));

    await importViaUi(page, "QA bad", "{ this is [not json");
    await page.waitForFunction(() => /cleared/.test(document.querySelector("form p.msg")?.textContent ?? ""));
    let msg = await page.textContent("form p.msg");
    check("malformed JSON: error shown", /cleared/.test(msg), msg);
    check("malformed JSON: message names nothing sensitive", !/\{ this|not json|SID|PSID/.test(msg), msg);
    check("textarea cleared after failure", (await page.inputValue("#cookies")) === "");

    const missingTs = cookieExport(FULL_NAMES.filter((n) => n !== "__Secure-1PSIDTS"));
    await importViaUi(page, "QA missing", missingTs);
    await page.waitForFunction(() => /cleared/.test(document.querySelector("form p.msg")?.textContent ?? ""));
    msg = await page.textContent("form p.msg");
    check("missing cookie: names only __Secure-1PSIDTS", /Missing: __Secure-1PSIDTS\./.test(msg) && !msg.includes(MARK), msg);
    check("no account was created by failures", /No accounts yet/.test(await page.textContent("main")));

    await importViaUi(page, "QA personal", cookieExport(FULL_NAMES));
    await page.waitForSelector(".badge.active");
    check("valid import: account listed Active", /QA personal/.test(await page.textContent("ul.list")) && /Active/.test(await page.textContent(".badge")));
    check("valid import: textarea cleared", (await page.inputValue("#cookies")) === "");
    check("valid import: success message", /Account connected/.test(await page.textContent("form p.msg")));
    const html = await page.content();
    check("pasted JSON / cookie values never shown back in page", !html.includes(MARK) && !html.includes("expirationDate"));
    check("cookie names count shown, not names", /8 cookie names stored/.test(await page.textContent("ul.list")));

    // Kill with confirm: cancel first
    await page.click('button[aria-label="Kill QA personal"]');
    check("kill asks for confirmation", await page.isVisible('button:has-text("Yes, do it")'));
    await page.click('button:has-text("Cancel")');
    check("cancel keeps account Active", (await page.textContent(".badge")).trim() === "Active");
    await page.click('button[aria-label="Kill QA personal"]');
    await page.click('button:has-text("Yes, do it")');
    await page.waitForSelector(".badge.disabled");
    check("kill -> Disabled", (await page.textContent(".badge")).trim() === "Disabled");
    check("disabled account has no Kill button", (await page.locator('button[aria-label^="Kill"]').count()) === 0);

    // import again then revoke-all
    await importViaUi(page, "QA second", cookieExport(FULL_NAMES, MARK + "B"));
    await page.waitForSelector(".badge.active");
    await page.click('button[aria-label="Revoke all accounts"]');
    check("revoke all asks for confirmation", await page.isVisible('button:has-text("Yes, do it")'));
    await page.click('button:has-text("Yes, do it")');
    await page.waitForFunction(() => document.querySelectorAll(".badge.disabled").length === 2);
    check("revoke all -> all Disabled", (await page.locator(".badge.active").count()) === 0 && (await page.locator(".badge.disabled").count()) === 2);
    check("page html free of cookie values after all steps", !(await page.content()).includes(MARK));
    await ctx.close();
  });

  // ---- 4 OAuth/MCP ----------------------------------------------------------------------------------
  section("4 OAuth + MCP");
  let clientId = null;
  const pk = newPkce();
  const state = "st" + crypto.randomBytes(6).toString("hex");
  let accessToken = null;
  let refreshToken = null;
  await guard("oauth", async () => {
    const meta = await (await api("/.well-known/oauth-authorization-server")).json();
    check("AS metadata: S256 only, issuer matches", meta.code_challenge_methods_supported?.join() === "S256" && meta.issuer === BASE, JSON.stringify(meta.code_challenge_methods_supported));
    const reg = await api("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    const regJson = await reg.json();
    clientId = regJson.client_id;
    check("DCR register 201 with client_id", reg.status === 201 && !!clientId, `status ${reg.status}`);
    check("DCR public client (no secret issued)", !regJson.client_secret);

    // Deny path
    const deny = await authorizeInBrowser(browser, "deny", { clientId, challenge: pk.challenge, state });
    check("authorize signed out -> /login?next=/oauth/authorize...", deny.landedLogin);
    check("consent page shows client name + redirect host", /Allow .Claude. to use NotebookLM/.test(deny.heading) && /claude\.ai/.test(deny.bodyText) && /never sees your Google cookies/.test(deny.bodyText), deny.heading);
    const du = deny.captured ? new URL(deny.captured) : null;
    check("Deny -> callback with error=access_denied and state", du?.searchParams.get("error") === "access_denied" && du.searchParams.get("state") === state, deny.captured?.split("?")[0]);
    check("Deny -> no code issued", !du?.searchParams.get("code"));

    // Approve path
    const ok = await authorizeInBrowser(browser, "approve", { clientId, challenge: pk.challenge, state });
    const au = ok.captured ? new URL(ok.captured) : null;
    const code = au?.searchParams.get("code");
    check("Approve -> callback with code and state", !!code && au.searchParams.get("state") === state);

    const tok = (c, v = pk.verifier) =>
      api("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: c, redirect_uri: CB, client_id: clientId, code_verifier: v, resource: BASE + "/api/mcp" }),
      });
    const bad = await tok(code, "wrong-verifier-wrong-verifier-wrong-verifier-wrong-verifier");
    check("token exchange with wrong PKCE verifier rejected", bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
    // a failed attempt may burn the code; get a fresh one for the happy path
    const ok2 = await authorizeInBrowser(browser, "approve", { clientId, challenge: pk.challenge, state });
    const code2 = new URL(ok2.captured).searchParams.get("code");
    const good = await tok(code2);
    const gj = await good.json();
    accessToken = gj.access_token;
    refreshToken = gj.refresh_token;
    check("token exchange 200 with access + refresh token", good.status === 200 && /^nlm_at_/.test(accessToken ?? "") && /^nlm_rt_/.test(refreshToken ?? ""), `status ${good.status}`);
    check("token response no-store, Bearer, ~1h", /no-store/.test(good.headers.get("cache-control") ?? "") && gj.token_type?.toLowerCase() === "bearer" && gj.expires_in === 3600);

    const replay = await tok(code2);
    check("replay of auth code rejected", replay.status >= 400 && replay.status < 500, `status ${replay.status}`);
    const afterReplay = await mcp(accessToken, { jsonrpc: "2.0", id: 99, method: "tools/list" });
    check("replay revokes the token family (documented behaviour)", afterReplay.status === 401, `status ${afterReplay.status}`);

    // fresh grant for the rest of the walkthrough
    const ok3 = await authorizeInBrowser(browser, "approve", { clientId, challenge: pk.challenge, state });
    const g3 = await (await tok(new URL(ok3.captured).searchParams.get("code"))).json();
    accessToken = g3.access_token;
    refreshToken = g3.refresh_token;
    check("fresh grant after replay works", !!accessToken && !!refreshToken);
  });

  await guard("mcp", async () => {
    const noTok = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const www = noTok.headers.get("www-authenticate") ?? "";
    check("/api/mcp without token -> 401", noTok.status === 401, `status ${noTok.status}`);
    check("401 has WWW-Authenticate Bearer + resource_metadata", /^Bearer/.test(www) && /resource_metadata="[^"]+oauth-protected-resource/.test(www), www.slice(0, 80));
    const badTok = await mcp("nlm_at_not-a-real-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    check("invalid bearer -> 401", badTok.status === 401, `status ${badTok.status}`);

    const init = await mcp(accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } },
    });
    check("initialize ok", init.status === 200 && !!init.json?.result?.serverInfo, `status ${init.status}`);
    const list = await mcp(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
    const expected = [
      "accounts_list", "notebooks_list", "notebook_create", "notebook_rename", "notebook_get", "notebook_summary",
      "source_add_url", "source_add_youtube", "source_add_text", "source_add_drive", "source_get_text", "source_get_guide",
      "studio_audio_create", "studio_video_create", "studio_status", "studio_download_link", "chat_ask",
    ].sort();
    check(`tools/list returns exactly the 17 expected tools (got ${names.length})`, JSON.stringify(names) === JSON.stringify(expected), `missing ${expected.filter((n) => !names.includes(n))} extra ${names.filter((n) => !expected.includes(n))}`);
    check("no tool is destructive", (list.json?.result?.tools ?? []).every((t) => t.annotations?.destructiveHint !== true));

    // accounts_list: needs an ACTIVE-or-not account; the vault flow left 2 disabled -> import one more via API
    const loginRes = await api("/api/owner/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...xff(ipCounter++) }, body: JSON.stringify({ passphrase: PASS }) });
    const sess = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    const imp = await api("/api/vault/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sess, origin: BASE },
      body: JSON.stringify({ label: "QA mcp account", json: cookieExport(FULL_NAMES, MARK + "M") }),
    });
    check("API import of synthetic account 201", imp.status === 201 || imp.status === 200, `status ${imp.status}`);
    const call = await mcp(accessToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "accounts_list", arguments: {} } });
    check("accounts_list 200 and not an error", call.status === 200 && !call.json?.result?.isError, call.text.slice(0, 120));
    check("accounts_list shows the synthetic account", /QA mcp account/.test(call.text));
    const leaks = [MARK, "SYNTHETICQAVALUE", "expirationDate", "__Secure-1PSIDTS", "cookie_value"].filter((x) => call.text.includes(x));
    check("accounts_list response contains no cookie data", leaks.length === 0, leaks.join(","));

    // refresh rotation
    const refresh = (rt) =>
      api("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }) });
    const r1 = await refresh(refreshToken);
    const r1j = await r1.json();
    check("refresh -> new access + refresh token", r1.status === 200 && r1j.refresh_token && r1j.refresh_token !== refreshToken && r1j.access_token !== accessToken, `status ${r1.status}`);
    const useNew = await mcp(r1j.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    check("new access token works", useNew.status === 200);
    const old = await refresh(refreshToken);
    check("old refresh token rejected", old.status >= 400 && old.status < 500, `status ${old.status}`);
    const afterReuse = await mcp(r1j.access_token, { jsonrpc: "2.0", id: 5, method: "tools/list" });
    check("reuse of a rotated refresh token revokes the family (documented)", afterReuse.status === 401, `status ${afterReuse.status}`);
  });

  // ---- 5 cron/health --------------------------------------------------------------------------------
  section("5 Cron and deep health");
  await guard("cron", async () => {
    for (const path of ["/api/cron/keepalive", "/api/health/deep"]) {
      const a = await api(path);
      check(`${path} without bearer -> 401`, a.status === 401, `status ${a.status}`);
      const b = await api(path, { headers: { authorization: "Bearer wrong-wrong-wrong" } });
      check(`${path} wrong bearer -> 401`, b.status === 401, `status ${b.status}`);
    }
    const ka = await api("/api/cron/keepalive", { headers: { authorization: `Bearer ${CRON}` } });
    const kaT = await ka.text();
    check("keepalive with CRON_SECRET -> 200 JSON", ka.status === 200 && kaT.startsWith("{"), `status ${ka.status}`);
    console.log("      keepalive body:", kaT.slice(0, 300));
    const dp = await api("/api/health/deep", { headers: { authorization: `Bearer ${CRON}` } });
    const dpT = await dp.text();
    check("deep health with CRON_SECRET -> 200 JSON", dp.status === 200 && dpT.startsWith("{"), `status ${dp.status}`);
    console.log("      deep body:", dpT.slice(0, 300));
    const all = kaT + dpT;
    check("cron/deep responses leak no cookies, names or secrets", ![MARK, "SYNTHETICQAVALUE", "QA mcp account", CRON, PASS, env.MASTER_SECRET].some((x) => all.includes(x)));
    check("cron responses no-store", /no-store/.test(ka.headers.get("cache-control") ?? "") && /no-store/.test(dp.headers.get("cache-control") ?? ""));
  });

  // ---- 6b screenshots with accounts + apps + consent ------------------------------------------------
  section("6b Screenshots: vault with account, confirm dialogs, consent");
  await forEachCombo(browser, { login: true }, async (page, theme, sz, phone) => {
    await page.goto(BASE + "/vault");
    await page.waitForSelector(".badge");
    // inject a needs_reauth badge ONLY for the contrast assertion (cannot be produced offline)
    await snap(page, "vault-accounts", theme, sz, phone);
    await page.evaluate(() => {
      const card = document.querySelector("li.card");
      const b = document.createElement("span");
      b.className = "badge needs_reauth";
      b.textContent = "Needs sign-in again";
      card.querySelector(".row").appendChild(b);
      return true;
    });
    await assertPage(page, `vault-accounts+needs_reauth badge ${theme} ${sz}`, { phone });
    await page.reload();
    await page.click('button[aria-label^="Kill "]');
    await snap(page, "vault-confirm-kill", theme, sz, phone);
    await page.click('button:has-text("Cancel")');
    await page.click('button[aria-label="Revoke all accounts"]');
    await snap(page, "vault-confirm-revoke-all", theme, sz, phone);
    await page.click('button:has-text("Cancel")');
    await page.click('button[aria-label^="Revoke Claude"]');
    await snap(page, "vault-confirm-revoke-app", theme, sz, phone);
  });
  await forEachCombo(browser, { login: true }, async (page, theme, sz, phone) => {
    const p = newPkce();
    await page.goto(
      `${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${p.challenge}&code_challenge_method=S256&scope=notebooklm&state=s&resource=${encodeURIComponent(BASE + "/api/mcp")}`,
    );
    await page.waitForSelector('button[value="approve"]');
    await snap(page, "oauth-consent", theme, sz, phone);
    await page.goto(`${BASE}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${p.challenge}&code_challenge_method=S256`);
    await snap(page, "oauth-consent-error", theme, sz, phone);
  });
} finally {
  await browser.close();
}

// ---- summary ----------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed; ${shotCount} screenshots written`);
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ total: results.length, failed: failed.length, screenshots: shotCount, results }, null, 1));
process.exit(failed.length ? 1 : 0);
