/** PROTOCOL §1.2 / §1.4: homepage token extraction and classification. Pure. */

export interface PageTokens {
  at: string | null;
  fsid: string | null;
  bl: string | null;
}

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Returns the value (possibly "") or null when the key is absent. */
export function extractWizField(html: string, key: string): string | null {
  const k = key.replace(/[^A-Za-z0-9_]/g, "");
  const variants = [
    new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`),
    new RegExp(`'${k}'\\s*:\\s*'([^']*)'`),
    new RegExp(`&quot;${k}&quot;\\s*:\\s*&quot;(.*?)&quot;`),
  ];
  for (const re of variants) {
    const m = re.exec(html);
    if (m) return unescapeHtml(m[1] ?? "");
  }
  return null;
}

export function extractPageTokens(html: string): PageTokens {
  return {
    at: extractWizField(html, "SNlM0e"),
    fsid: extractWizField(html, "FdrFJe"),
    bl: extractWizField(html, "cfb2h"),
  };
}

export type HomepageState = "ok" | "signed_out" | "cookie_mismatch" | "region_gate" | "unknown";

export function classifyHomepage(i: { finalUrl: string; status: number; html: string }): HomepageState {
  const url = i.finalUrl;
  if (/location=unsupported/.test(url)) return "region_gate";
  if (/accounts\.google\.com\/[^?]*CookieMismatch/i.test(url)) return "cookie_mismatch";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* unparsable URL */
  }
  if (host === "accounts.google.com") return "signed_out";
  if (/^notebook(lm)?\.google$/.test(host)) return "region_gate";
  if (i.status !== 200) return "unknown";
  if (i.html.includes("landing-header-signin")) return "signed_out";
  const at = extractWizField(i.html, "SNlM0e");
  if (at === null || at === "") return "signed_out";
  return "ok";
}
