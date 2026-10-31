// Regression test: Approve/Deny on the OAuth consent page must reach the client's redirect URI in a REAL browser.
// Why it exists: the site-wide CSP `form-action 'self'` made Chromium silently block the 303 back to claude.ai, so Approve
// "did nothing". The earlier QA harness intercepted /oauth/consent itself and never exercised the redirect.
// Usage: .env.local with SYNTHETIC OWNER_PASSPHRASE / MASTER_SECRET / PUBLIC_BASE_URL=http://localhost:3100 / CRON_SECRET,
//        fresh `npx next dev -p 3100`, then `node docs/qa/consent-redirect.mjs`. Only the claude.ai request is stubbed.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3100";
const CB = "https://claude.ai/api/mcp/auth_callback";
const env = Object.fromEntries(readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const b64u = (b) => Buffer.from(b).toString("base64url");
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : "  -> " + extra}`); };

const browser = await chromium.launch();
// NOTE: Playwright cannot intercept redirect hops, so after the 303 the browser really navigates to claude.ai (needs internet).
// We assert on (a) the consent response the server sent, (b) the browser actually leaving our origin, (c) no CSP violation.
async function run(decision) {
  const ctx = await browser.newContext();
  const csp = [];
  let consent = null;
  const reg = await ctx.request.post(BASE + "/oauth/register", { data: { client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } });
  const clientId = (await reg.json()).client_id;
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const state = "st" + crypto.randomBytes(5).toString("hex");
  const page = await ctx.newPage();
  page.on("console", (m) => { if (/content security policy|form-action/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.url().endsWith("/oauth/consent")) consent = { status: r.status(), location: r.headers()["location"] ?? "" }; });
  await page.goto(`${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256&scope=notebooklm&state=${state}&resource=${encodeURIComponent(BASE + "/api/mcp")}`);
  await page.fill("#passphrase", env.OWNER_PASSPHRASE);
  await Promise.all([page.waitForURL(/\/oauth\/authorize/), page.click('button:has-text("Sign in")')]);
  await page.click(`button[value="${decision}"]`);
  for (let i = 0; i < 60 && new URL(page.url()).hostname === new URL(BASE).hostname && csp.length === 0; i++) await page.waitForTimeout(200);
  const left = new URL(page.url()).hostname !== new URL(BASE).hostname;
  const loc = consent?.location ? new URL(consent.location) : null;
  return { csp, consent, loc, left, clientId, verifier, state, ctx };
}

const ap = await run("approve");
check("Approve: no CSP violation (form-action must allow the redirect back to the client)", ap.csp.length === 0, ap.csp.join(" | "));
check("Approve: server answered 303 to the client's redirect URI", ap.consent?.status === 303 && ap.loc?.origin + ap.loc?.pathname === CB, JSON.stringify(ap.consent && { status: ap.consent.status }));
check("Approve: the browser actually left our origin (navigated to the client)", ap.left);
if (ap.loc) {
  check("Approve: callback carries code and the original state", !!ap.loc.searchParams.get("code") && ap.loc.searchParams.get("state") === ap.state);
  const tok = await ap.ctx.request.post(BASE + "/oauth/token", { form: { grant_type: "authorization_code", code: ap.loc.searchParams.get("code"), redirect_uri: CB, client_id: ap.clientId, code_verifier: ap.verifier } });
  const tj = await tok.json().catch(() => ({}));
  check("Approve: the issued code exchanges for tokens (PKCE verified)", tok.status() === 200 && !!tj.access_token && !!tj.refresh_token, `status ${tok.status()}`);
}
await ap.ctx.close();

const dn = await run("deny");
check("Deny: no CSP violation and the browser returned to the client with error=access_denied + state",
  dn.csp.length === 0 && dn.left && dn.loc?.searchParams.get("error") === "access_denied" && dn.loc?.searchParams.get("state") === dn.state, dn.csp.join(" | "));
await dn.ctx.close();

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall consent redirect checks passed");
process.exit(failed ? 1 : 0);
