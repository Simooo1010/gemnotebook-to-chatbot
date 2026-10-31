// Extra production-mode checks (HTTP only): CORS, body limits, consent CSRF, token-replay race, restart persistence.
// Usage: QA_SERVER_PID=<pid of next-server on :3300> QA_LOGS=/tmp/qa-logs node docs/qa/prod-extra.mjs   (emulator + app up via run-prod.sh)
// The restart section kills that PID and starts `next start` again with the same env (instance change = serverless cold start).
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

// ---- token-replay race ---------------------------------------------------------------------------------------------------
let survived = 0;
const ROUNDS = 8;
for (let i = 0; i < ROUNDS; i++) {
  const { code, v } = await newCode();
  const f = { grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: v };
  const rs = await Promise.all([tok(f), tok(f)]);
  const win = (await Promise.all(rs.map((x) => x.json()))).find((b) => b.access_token);
  const rf = await tok({ grant_type: "refresh_token", refresh_token: win.refresh_token, client_id: clientId });
  if (rf.status === 200) survived++;
}
check(`concurrent replay of one auth code revokes the WHOLE family (refresh token must not survive) [${survived}/${ROUNDS} rounds left a working refresh token]`, survived === 0, `survived ${survived}/${ROUNDS}`);

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
