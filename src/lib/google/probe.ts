// Google reachability probe: one UNAUTHENTICATED GET of the NotebookLM homepage from this server's IP.
// Returns metadata only (classification, hosts, path without query, status): never the body, never cookies.
import { createHash, timingSafeEqual } from "node:crypto";
import { classifyHomepage, type HomepageState } from "@/lib/rpc/page";
import { browserHeaders, isAllowedHost, type FetchLike } from "./http";

export const PROBE_MAX_HOPS = 6;
export const DEFAULT_PROBE_BASE = "https://notebook.google.com";

export interface ProbeResult {
  classification: HomepageState;
  finalHost: string;
  /** Path of the final URL, query stripped. */
  finalPath: string;
  status: number;
  hopHosts: string[];
  /** Present only when the probe itself could not complete. */
  error?: "disallowed_host" | "too_many_redirects" | "network";
}

const failure = (error: NonNullable<ProbeResult["error"]>, hopHosts: string[], finalHost: string, finalPath = "", status = 0): ProbeResult => ({
  classification: "unknown",
  finalHost,
  finalPath,
  status,
  hopHosts,
  error,
});

export async function runGoogleProbe(i: { fetch: FetchLike; base?: string | null; signal?: AbortSignal }): Promise<ProbeResult> {
  const base = (i.base?.trim() || DEFAULT_PROBE_BASE).replace(/\/+$/, "");
  let url: string;
  try {
    const u = new URL(`${base}/`);
    u.searchParams.set("hl", "en");
    url = u.toString();
  } catch {
    return failure("disallowed_host", [], "invalid");
  }
  const hopHosts: string[] = [];
  for (let hop = 0; ; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return failure("disallowed_host", hopHosts, "invalid");
    }
    if (u.protocol !== "https:" || !isAllowedHost(u.hostname)) return failure("disallowed_host", hopHosts, u.hostname, u.pathname);
    hopHosts.push(u.hostname);
    let response;
    try {
      response = await i.fetch(url, { method: "GET", headers: browserHeaders("document"), redirect: "manual", signal: i.signal });
    } catch {
      return failure("network", hopHosts, u.hostname, u.pathname);
    }
    const loc = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && loc) {
      if (hop >= PROBE_MAX_HOPS) return failure("too_many_redirects", hopHosts, u.hostname, u.pathname, response.status);
      url = new URL(loc, url).toString();
      continue;
    }
    let html = "";
    try {
      html = await response.text();
    } catch {
      /* classification falls back to status/URL */
    }
    return {
      classification: classifyHomepage({ finalUrl: url, status: response.status, html }),
      finalHost: u.hostname,
      finalPath: u.pathname,
      status: response.status,
      hopHosts,
    };
  }
}

/** Constant-time `Authorization: Bearer <secret>` check. Fails closed when the secret is unset or empty. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.trim() === "") return false;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const given = createHash("sha256").update(m?.[1] ?? "").digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected) && m !== null;
}
