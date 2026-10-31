// Build-time Google reachability probe (Vercel only). One UNAUTHENTICATED GET of the NotebookLM homepage
// from the build machine's IP. Prints metadata only (hosts, status, gate flag); never the body; never fails the build.
// Result is read from the deployment build log. Runtime IPs differ from build IPs, but both are datacenter ranges.
if (!process.env.VERCEL) process.exit(0);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const allowed = (h) => h === "google.com" || h.endsWith(".google.com") || h === "notebook.google" || h === "notebooklm.google";
const hops = [];
let url = `${(process.env.NOTEBOOKLM_BASE_URL || "https://notebook.google.com").replace(/\/+$/, "")}/?hl=en`;
const out = { probe: "google-reachability", hops, status: 0, gate: false, signInRedirect: false, error: null };

try {
  for (let i = 0; i < 7; i++) {
    const u = new URL(url);
    if (!allowed(u.hostname)) { out.error = "disallowed_host"; break; }
    hops.push(u.hostname + u.pathname);
    if (u.search.includes("location=unsupported") || u.pathname.includes("CookieMismatch")) out.gate = u.search.includes("location=unsupported");
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(15000) });
    out.status = res.status;
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      if (url.includes("location=unsupported")) out.gate = true;
      continue;
    }
    out.signInRedirect = new URL(url).hostname === "accounts.google.com";
    break;
  }
} catch (e) {
  out.error = e && e.name ? e.name : "network";
}
console.log("[google-probe] " + JSON.stringify(out));
process.exit(0);
