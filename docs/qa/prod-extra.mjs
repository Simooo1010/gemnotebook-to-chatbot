// Extra production-mode checks (HTTP only): CORS, body limits, consent CSRF, token races (20 rounds each), registration flood limit,
// redirect allow-list, live-client cap, prune via keep-alive, header hygiene, login storage-outage answer, restart persistence.
// Usage: QA_SERVER_PID=<pid of next-server on :3300> QA_LOGS=/tmp/qa-logs node docs/qa/prod-extra.mjs   (emulator + app up via run-prod.sh)
// Needs a FRESH emulator + server (the live-client cap check counts every registered client). The restart section kills that PID and starts `next start` again with the same env (instance change = serverless cold start).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const BASE = "http://localhost:3300", CB = "https://claude.ai/api/mcp/auth_callback";
const root = new URL("../../", import.meta.url).pathname;
const readEnv = (f) => Object.fromEntries(readFileSync(root + f, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const env = readEnv(".env.local"), SBK = readEnv(".env.sbkey.local").FAKE_SB_KEY;
const PASS = env.OWNER_PASSPHRASE;
let failed = 0;
const check = (n, ok, x = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  -> " + String(x).slice(0, 300)}`); };
const b64u = (b) => Buffer.from(b).toString("base64url");
let n = 100;
const xff = () => ({ "x-forwarded-for": `10.8.0.${n++ % 250}` });
const jpost = (path, body, h = {}) => fetch(BASE + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...h }, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---- body limits / methods / CORS --------------------------------------------------------------------------------
let r = await jpost("/api/owner/login", JSON.stringify({ passphrase: "x".repeat(200_000) }), { origin: BASE, ...xff() });
check("login: 200 kB body -> 4xx (no 500)", r.status >= 400 && r.status < 500, r.status);
r = await jpost("/oauth/register", JSON.stringify({ client_name: "x".repeat(200_000), redirect_uris: [CB] }));
check("register: 200 kB body -> 4xx", r.status >= 400 && r.status < 500, r.status);
r = await fetch(BASE + "/api/mcp");
check("GET /api/mcp -> 405 (or 401), not 500", [401, 405].includes(r.status), r.status);
for (const [origin, ok] of [["https://claude.ai", true], ["https://evil.example", false]]) {
  for (const path of ["/oauth/register", "/oauth/token", "/api/mcp"]) {
    const p = await fetch(BASE + path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });
    const acao = p.headers.get("access-control-allow-origin");
    check(`CORS preflight ${path} from ${origin}: ${ok ? "allowed" : "NOT allowed"}`, ok ? acao === origin : !acao || (acao !== origin && acao !== "*"), `status ${p.status} acao=${acao}`);
  }
}

// ---- owner session + consent plumbing -------------------------------------------------------------------------------
const lr = await jpost("/api/owner/login", { passphrase: PASS }, { origin: BASE, ...xff() });
const cookie = lr.headers.getSetCookie()[0].split(";")[0];
const clientId = (await (await jpost("/oauth/register", { client_name: "Extra", redirect_uris: [CB], token_endpoint_auth_method: "none" })).json()).client_id;
async function consentFields(challenge) {
  const u = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256&scope=notebooklm&state=s`;
  const html = await (await fetch(u, { headers: { cookie } })).text();
  const f = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) { const nm = /name="([^"]+)"/.exec(m[0])?.[1]; const v = /value="([^"]*)"/.exec(m[0])?.[1] ?? ""; if (nm) f[nm] = v.replace(/&amp;/g, "&").replace(/&quot;/g, '"'); }
  return f;
}
const consent = (f, h = { cookie, origin: BASE }) => fetch(BASE + "/oauth/consent", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams({ ...f, decision: "approve" }) });
async function newCode() {
  const v = b64u(crypto.randomBytes(48)), ch = b64u(crypto.createHash("sha256").update(v).digest());
  const f = await consentFields(ch);
  const res = await consent(f);
  return { code: new URL(res.headers.get("location")).searchParams.get("code"), v, f };
}
{
  const v = b64u(crypto.randomBytes(48)), ch = b64u(crypto.createHash("sha256").update(v).digest());
  const f = await consentFields(ch);
  const bad = await consent({ ...f, csrf: "tampered" });
  check("consent with tampered CSRF -> 403, no redirect to client", bad.status === 403 && !bad.headers.get("location"), `status ${bad.status}`);
  const nocookie = await consent(f, { origin: BASE });
  check("consent without owner session -> not a 303 to the client", !/claude\.ai/.test(nocookie.headers.get("location") ?? ""), `status ${nocookie.status}`);
  const foreign = await consent(f, { cookie, origin: "https://evil.example" });
  check("consent from foreign Origin -> 403", foreign.status === 403, `status ${foreign.status}`);
}
const tok = (form) => fetch(BASE + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
const mcp = (t, body) => fetch(BASE + "/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` }, body: JSON.stringify(body) });

// ---- token races (Fix T2-1 / T4-1 / T1-5) ------------------------------------------------------------------------------
const ROUNDS = 20;
let cleanReplay = 0, oneWinner = 0, zeroWinners = 0, twoWinners = 0, liveLeft = 0;
for (let i = 0; i < ROUNDS; i++) {
  const { code, v } = await newCode();
  const f = { grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v };
  const rs = await Promise.all([tok(f), tok(f)]);
  const bodies = await Promise.all(rs.map((x) => x.json()));
  const wins = bodies.filter((b) => b.access_token);
  if (wins.length === 1) oneWinner++; else if (wins.length === 0) zeroWinners++; else twoWinners++;
  let alive = 0;
  for (const w of wins) {
    if ((await mcp(w.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status === 200) alive++;
    if ((await tok({ grant_type: "refresh_token", refresh_token: w.refresh_token, client_id: clientId })).status === 200) alive++;
  }
  liveLeft += alive;
  if (alive === 0 && wins.length <= 1) cleanReplay++;
}
console.log(`      code replay race over ${ROUNDS} rounds: 1x200 ${oneWinner}, 0x200 ${zeroWinners}, 2x200 ${twoWinners}; live tokens left ${liveLeft}`);
check(`concurrent replay of one auth code: at most one 200 and NO live token of the family afterwards [${cleanReplay}/${ROUNDS} rounds clean]`, cleanReplay === ROUNDS, `clean ${cleanReplay}/${ROUNDS}, live left ${liveLeft}`);

let bothOk = 0, sessionOk = 0;
for (let i = 0; i < ROUNDS; i++) {
  const { code, v } = await newCode();
  const g0 = await (await tok({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v })).json();
  const rf = { grant_type: "refresh_token", refresh_token: g0.refresh_token, client_id: clientId };
  const rs = await Promise.all([tok(rf), tok(rf)]);
  if (rs.every((x) => x.status === 200)) {
    bothOk++;
    const [x, y] = await Promise.all(rs.map((r) => r.json()));
    const ok1 = (await mcp(x.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status === 200;
    const ok2 = (await tok({ grant_type: "refresh_token", refresh_token: y.refresh_token, client_id: clientId })).status === 200;
    if (ok1 && ok2) sessionOk++;
  }
}
check(`concurrent double refresh: both 200 and the session keeps working [${bothOk}/${ROUNDS} both 200, ${sessionOk}/${ROUNDS} session alive]`, bothOk === ROUNDS && sessionOk === ROUNDS, `${bothOk}/${sessionOk}`);

// ---- registration hardening (Fix T2-2 / T1-1 / T5-7, T2-3) ------------------------------------------------------------------
const emu = (path, method = "GET", body) => fetch("http://127.0.0.1:3410" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const reg = (ip, uri = CB, name = "Claude") => jpost("/oauth/register", { client_name: name, redirect_uris: [uri] }, ip ? { "x-forwarded-for": ip } : {});
{
  const flood = [];
  for (let i = 0; i < 12; i++) flood.push(await reg("198.51.100.77"));
  check("register flood from one IP: first 10 -> 201, then 429 with Retry-After", flood.slice(0, 10).every((r) => r.status === 201) && flood.slice(10).every((r) => r.status === 429 && r.headers.get("retry-after")), flood.map((r) => r.status).join());
  check("another IP is unaffected", (await reg("198.51.100.78")).status === 201);
  const t = await emu("/__qa/tables");
  check("oauth_clients.ip_hash holds 64-hex hashes, never the IP", t.oauth_clients.some((c) => c.ip_hash) && t.oauth_clients.every((c) => c.ip_hash === null || /^[0-9a-f]{64}$/.test(c.ip_hash)) && !JSON.stringify(t.oauth_clients).includes("198.51.100"));
  // (`next start` fills in x-forwarded-for from the socket when a request has none, so the harness's own registrations share one hash)
  const perIp = Object.values(t.oauth_clients.reduce((m, c) => ((m[c.ip_hash] = (m[c.ip_hash] ?? 0) + 1), m), {}));
  check("a refused registration leaves no row: exactly 10 rows for the flooding IP, 1 for the other IP", perIp.includes(10) && Math.max(...perIp) === 10 && perIp.filter((n) => n === 1).length >= 1, JSON.stringify(perIp));
  const evil = await reg("198.51.100.79", "https://evil.example/cb", "Claude");
  check("spoof: https://evil.example/cb as 'Claude' -> 400 invalid_redirect_uri", evil.status === 400 && (await evil.json()).error === "invalid_redirect_uri");
  check("loopback http (Claude Code) and claude.com callback are accepted", (await reg("198.51.100.79", "http://localhost:6274/oauth/callback")).status === 201 && (await reg("198.51.100.79", "https://claude.com/api/mcp/auth_callback")).status === 201);
}
{
  // consent page: host shown, warning for anything but claude.ai / claude.com
  const page = async (uri) => {
    const id = (await (await reg("198.51.100.80", uri)).json()).client_id;
    const u = `${BASE}/oauth/authorize?response_type=code&client_id=${id}&redirect_uri=${encodeURIComponent(uri)}&code_challenge=${b64u(crypto.randomBytes(32))}&code_challenge_method=S256&scope=notebooklm`;
    return (await fetch(u, { headers: { cookie } })).text();
  };
  const lb = await page("http://localhost:6274/oauth/callback");
  check("consent for a loopback app: shows the return host prominently and a plain warning", /localhost:6274/.test(lb) && /Warning: this app is not Claude/.test(lb));
  const cl = await page(CB);
  check("consent for claude.ai: host shown, no warning", /claude\.ai/.test(cl) && !/Warning: this app is not Claude/.test(cl));
}
{
  // live-client cap: fresh registrations count, abandoned ones (> 1 h, no token) do not; prune removes them
  const before = (await emu("/__qa/tables")).oauth_clients.length;
  for (let i = before, ip = 0; i < 200; i++) { if (i % 9 === 0) ip++; const r = await reg(`203.0.113.${ip}`); if (r.status !== 201) { check("filling to the cap", false, `${i} ${r.status}`); break; } }
  const full = await reg("203.0.113.250");
  check("200 live clients: the 201st registration is refused (cap)", full.status === 400 && /Too many registered apps/.test((await full.text())));
  await emu("/__qa/age", "POST", { table: "oauth_clients", ms: 2 * 3600_000 });
  const after = await reg("203.0.113.251");
  check("after the abandoned registrations are > 1 h old (no token) they no longer block the owner/Claude", after.status === 201, after.status);
  const aged = (await emu("/__qa/tables")).oauth_clients;
  const withTok = aged.filter((c) => c.has_token).length;
  const ka = await fetch(BASE + "/api/cron/keepalive", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  check("keep-alive answers 200 (prune is best effort, invisible)", ka.status === 200, ka.status);
  const left = (await emu("/__qa/tables")).oauth_clients;
  check(`prune_expired via keep-alive: abandoned clients > 1 h deleted (${aged.length} -> ${left.length}), the client that holds tokens and the fresh one stay`, left.length === withTok + 1 && left.some((c) => c.client_id === clientId) && left.every((c) => c.has_token || Date.now() - Date.parse(c.created_at) < 3600_000), `${aged.length} -> ${left.length}, with token ${withTok}`);
  const log = await emu("/__qa/log");
  check("keep-alive called the RPC with the service key (POST /rest/v1/rpc/prune_expired -> 200)", log.some((e) => e.method === "POST" && e.path === "/rest/v1/rpc/prune_expired" && e.status === 200));
}

// ---- header hygiene (Fix T2-4 / T2-5) ----------------------------------------------------------------------------------------
{
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } } };
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const none = await fetch(BASE + "/api/mcp", { method: "POST", headers: h, body: JSON.stringify(init) });
  const wa = none.headers.get("www-authenticate") ?? "";
  check("401 without Authorization: WWW-Authenticate has resource_metadata and NO error/error_description (RFC 6750 3.1)", none.status === 401 && /resource_metadata=/.test(wa) && !/error/.test(wa), wa);
  const bad = await fetch(BASE + "/api/mcp", { method: "POST", headers: { ...h, authorization: "Bearer nlm_at_nope" }, body: JSON.stringify(init) });
  check("401 with a bad token keeps error=\"invalid_token\"", bad.status === 401 && /error="invalid_token"/.test(bad.headers.get("www-authenticate") ?? ""));
  const pre = await fetch(BASE + "/api/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,mcp-protocol-version,mcp-session-id,accept,last-event-id" } });
  const ah = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check("CORS preflight allows Mcp-Session-Id, Accept, Last-Event-ID and DELETE", ["mcp-session-id", "accept", "last-event-id"].every((x) => ah.includes(x)) && /DELETE/.test(pre.headers.get("access-control-allow-methods") ?? ""), ah);
  const { code, v } = await newCode();
  const gt = await (await tok({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v })).json();
  const ok = await fetch(BASE + "/api/mcp", { method: "POST", headers: { ...h, authorization: `Bearer ${gt.access_token}`, origin: "https://claude.ai" }, body: JSON.stringify(init) });
  check("responses expose WWW-Authenticate and Mcp-Session-Id", /WWW-Authenticate, Mcp-Session-Id/i.test(ok.headers.get("access-control-expose-headers") ?? ""));
  const text = await ok.text();
  check("initialize does not advertise tools.listChanged:true (stateless server)", ok.status === 200 && !/"listChanged":true/.test(text), text.slice(0, 200));
  const ic = await tok({ grant_type: "refresh_token", refresh_token: "nlm_rt_x", client_id: "nlm_c_unknown" });
  check("/oauth/token invalid_client -> 401 with WWW-Authenticate", ic.status === 401 && !!ic.headers.get("www-authenticate"), ic.status);
}

// ---- storage outage + health (Fix T4-2) -------------------------------------------------------------------------------------
{
  await emu("/__qa/fault", "POST", { table: "login_attempts", status: 503, times: 1 });
  const l = await jpost("/api/owner/login", { passphrase: PASS }, { origin: BASE, "x-forwarded-for": "198.51.100.95" });
  const lj = await l.json();
  check("login while storage is down -> 503 storage_unavailable (not 429 'Too many attempts')", l.status === 503 && lj.error?.code === "storage_unavailable" && !l.headers.get("set-cookie"), `${l.status} ${JSON.stringify(lj)}`);
  const hl = await (await fetch(BASE + "/api/health")).json();
  check("/api/health reports storage:true and ok:true with Supabase configured (booleans only)", hl.ok === true && hl.storage === true && !JSON.stringify(hl).includes(SBK));
}

// ---- restart persistence ---------------------------------------------------------------------------------------------------
const { code, v } = await newCode();
const g = await (await tok({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v })).json();
const names = ["__Secure-1PSID", "__Secure-3PSID", "SAPISID", "SSID", "__Secure-1PSIDTS", "OSID"];
const exp = JSON.stringify(names.map((nm, i) => ({ domain: ".google.com", name: nm, value: `SYNTHETICQAVALUEextra_${nm}_${i}`, path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 2000000000 })));
const imp = await jpost("/api/vault/accounts", { label: "Persist", json: exp }, { cookie, origin: BASE });
check("import before restart -> 201", imp.status === 201, imp.status);
const pid = Number(process.env.QA_SERVER_PID);
if (pid) {
  process.kill(pid);
  await new Promise((r) => setTimeout(r, 1500));
  const logs = process.env.QA_LOGS ?? "/tmp/qa-logs";
  const child = spawn(process.execPath, [root + "node_modules/next/dist/bin/next", "start", "-p", "3300"], { cwd: root, detached: true, stdio: ["ignore", readFileSync ? (await import("node:fs")).openSync(`${logs}/server.log`, "a") : "ignore", (await import("node:fs")).openSync(`${logs}/server.log`, "a")], env: { ...process.env, ...env, SUPABASE_URL: "http://127.0.0.1:3410", SUPABASE_SERVICE_ROLE_KEY: SBK, NODE_ENV: "production" } });
  child.unref();
  console.log("      restarted server, new pid", child.pid);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const l = await mcp(g.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("after restart: previously issued access token still valid (OAuth state is in storage)", l.status === 200, l.status);
  const rr = await tok({ grant_type: "refresh_token", refresh_token: g.refresh_token, client_id: clientId });
  check("after restart: refresh token still valid", rr.status === 200, rr.status);
  const vp = await fetch(BASE + "/vault", { headers: { cookie } });
  check("after restart: owner session cookie still valid (HMAC key derived from MASTER_SECRET)", vp.status === 200, vp.status);
  const nt = JSON.parse(await rr.text()).access_token;
  const al = await (await mcp(nt, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "accounts_list", arguments: {} } })).text();
  check("after restart: vault account still listed (storage-backed)", /Persist/.test(al), al.slice(0, 120));
} else console.log("      (QA_SERVER_PID not set: restart section skipped)");
console.log(failed ? `${failed} FAILED` : "all extra checks passed");
process.exit(failed ? 1 : 0);
