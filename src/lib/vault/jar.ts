// Google cookie jar: parse exports, build Cookie headers, merge Set-Cookie. Pure: no I/O, no logging.

export type SameSite = "strict" | "lax" | "none";

export interface Cookie {
  name: string;
  value: string;
  /** Leading "." = domain cookie (matches subdomains); no dot = host-only. */
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; absent = session cookie. */
  expires?: number;
  sameSite?: SameSite;
}

export interface CookieJar {
  cookies: Cookie[];
}

export const REQUIRED_COOKIES = ["SID", "__Secure-1PSIDTS"] as const;
/**
 * The primary session cookie is the legacy `SID` OR its secure twin `__Secure-1PSID`: newer Google sessions
 * carry only the secure one (observed in a real export, 2026-10-31). `__Secure-1PSIDTS` is always required.
 */
export const PRIMARY_SESSION_COOKIES = ["SID", "__Secure-1PSID"] as const;

/** Names of required cookies that are absent (names only). For the primary session cookie the reported name is `SID`. */
export function missingRequiredCookies(names: Iterable<string>): string[] {
  const have = new Set(names);
  const missing: string[] = [];
  if (!PRIMARY_SESSION_COOKIES.some((n) => have.has(n))) missing.push("SID");
  if (!have.has("__Secure-1PSIDTS")) missing.push("__Secure-1PSIDTS");
  return missing;
}
export const MAX_COOKIES = 200;
export const MAX_VALUE_BYTES = 8 * 1024;

export type JarErrorCode = "invalid_format" | "missing_required" | "too_many_cookies";

/** Errors carry cookie NAMES at most, never values. */
export class JarError extends Error {
  constructor(
    readonly code: JarErrorCode,
    readonly missing: string[] = [],
  ) {
    super(code === "missing_required" ? `missing required cookies: ${missing.join(", ")}` : `cookie import: ${code}`);
    this.name = "JarError";
  }
}

/**
 * Recognises a JarError even when it comes from another copy of this module (the vault singleton can be
 * created from a different module graph, e.g. Turbopack dev or split server bundles), where instanceof fails.
 */
export function isJarError(e: unknown): e is JarError {
  if (e instanceof JarError) return true;
  if (!(e instanceof Error) || e.name !== "JarError") return false;
  const o = e as unknown as { code?: unknown; missing?: unknown };
  if (typeof o.code !== "string") return false;
  return o.missing === undefined || (Array.isArray(o.missing) && o.missing.every((m) => typeof m === "string"));
}

const bareDomain = (d: string) => d.trim().toLowerCase().replace(/^\.+/, "");

/** Allowlist from PROTOCOL §1.1. */
export function isAllowedDomain(domain: string): boolean {
  const d = bareDomain(domain);
  if (!d || !/^[a-z0-9.-]+$/.test(d)) return false;
  if (d === "google.com" || d.endsWith(".google.com")) return true;
  if (d === "googleusercontent.com" || d.endsWith(".googleusercontent.com")) return true;
  // Regional ccTLDs: google.de, google.co.uk, google.com.au (and subdomains).
  return /^(?:[a-z0-9-]+\.)*google\.(?:[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(d);
}

function normSameSite(v: unknown): SameSite | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.toLowerCase();
  if (s === "strict" || s === "lax") return s;
  if (s === "none" || s === "no_restriction") return "none";
  return undefined; // "unspecified" etc.
}

const key = (c: Pick<Cookie, "name" | "domain" | "path">) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

/** Accepts Cookie-Editor / EditThisCookie JSON arrays (or `{cookies:[...]}`). */
export function parseCookieExport(json: unknown): CookieJar {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new JarError("invalid_format");
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input) && Array.isArray((input as { cookies?: unknown }).cookies)) {
    input = (input as { cookies: unknown[] }).cookies;
  }
  if (!Array.isArray(input)) throw new JarError("invalid_format");
  if (input.length > MAX_COOKIES * 5) throw new JarError("too_many_cookies");

  const map = new Map<string, Cookie>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.value !== "string" || typeof r.domain !== "string") continue;
    if (!r.name || /[\s;=,]/.test(r.name) || /[;\r\n]/.test(r.value)) continue;
    if (Buffer.byteLength(r.value, "utf8") > MAX_VALUE_BYTES) continue;
    if (!isAllowedDomain(r.domain)) continue;
    const hostOnly = r.hostOnly === true || (r.hostOnly === undefined && !r.domain.trim().startsWith("."));
    const d = bareDomain(r.domain);
    const c: Cookie = {
      name: r.name,
      value: r.value,
      domain: hostOnly ? d : `.${d}`,
      path: typeof r.path === "string" && r.path.startsWith("/") ? r.path : "/",
      secure: r.secure === true,
      httpOnly: r.httpOnly === true,
    };
    const exp = typeof r.expirationDate === "number" ? r.expirationDate : typeof r.expires === "number" ? r.expires : undefined;
    if (exp !== undefined && Number.isFinite(exp) && r.session !== true) c.expires = Math.floor(exp);
    const ss = normSameSite(r.sameSite);
    if (ss) c.sameSite = ss;
    map.set(key(c), c);
  }
  const cookies = [...map.values()];
  if (cookies.length > MAX_COOKIES) throw new JarError("too_many_cookies");
  const names = new Set(cookies.map((c) => c.name));
  const missing = missingRequiredCookies(names);
  if (missing.length) throw new JarError("missing_required", missing);
  return { cookies };
}

function domainMatches(host: string, cookieDomain: string): boolean {
  if (cookieDomain.startsWith(".")) {
    const d = cookieDomain.slice(1);
    return host === d || host.endsWith(`.${d}`);
  }
  return host === cookieDomain;
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

const nowSec = (nowMs: number) => Math.floor(nowMs / 1000);

function matchingCookies(jar: CookieJar, url: string, nowMs: number): Cookie[] {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const secure = u.protocol === "https:";
  const t = nowSec(nowMs);
  return jar.cookies.filter(
    (c) =>
      domainMatches(host, c.domain) &&
      pathMatches(u.pathname || "/", c.path) &&
      (!c.secure || secure) &&
      (c.expires === undefined || c.expires > t),
  );
}

const toHeader = (cookies: Cookie[]) =>
  [...cookies]
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

/** Cookie header value for `url`, or "" when nothing matches. Longer paths first (RFC 6265 §5.4). */
export function cookieHeaderFor(jar: CookieJar, url: string, nowMs: number = Date.now()): string {
  return toHeader(matchingCookies(jar, url, nowMs));
}

/** Cookies that must never be re-scoped onto download hosts (reference CLI deletes them before downloads). */
const MEDIA_EXCLUDED_NAMES = new Set(["OSID", "__Secure-OSID"]);

const isGoogleusercontentHost = (host: string) => host === "googleusercontent.com" || host.endsWith(".googleusercontent.com");

/**
 * MEDIA-ONLY cookie header (never stored, never used for RPC/page requests).
 *
 * Real exports carry session cookies on `.google.com` only; nothing is scoped to `.googleusercontent.com`, so the
 * normal domain match would send `lh3.googleusercontent.com` no cookies at all. The reference CLI
 * (jacob-bd/notebooklm-mcp-cli `core/base.py` ~L593-623, `core/download.py`) duplicates the `.google.com` auth
 * cookies onto `.googleusercontent.com` "required for artifact downloads that redirect to googleusercontent.com",
 * and deletes `OSID` / `__Secure-OSID` first ("when it leaks onto download hosts Google redirects to ServiceLogin").
 * We do the same as a per-request VIEW: for `*.googleusercontent.com` only, the jar's domain-wide `.google.com`
 * cookies (not host-only ones, not OSID/__Secure-OSID) are added to whatever genuinely matches the host. The view
 * is a string built per hop and thrown away: the jar and the vault are never touched, and every other host gets
 * exactly `cookieHeaderFor`.
 */
export function mediaCookieHeaderFor(jar: CookieJar, url: string, nowMs: number = Date.now()): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (!isGoogleusercontentHost(host) || u.protocol !== "https:") return cookieHeaderFor(jar, url, nowMs);
  const t = nowSec(nowMs);
  const genuine = matchingCookies(jar, url, nowMs);
  const rescoped = jar.cookies.filter(
    (c) =>
      c.domain === ".google.com" && // domain-wide only: host-only cookies are never re-scoped
      !MEDIA_EXCLUDED_NAMES.has(c.name) &&
      pathMatches(u.pathname || "/", c.path) &&
      (c.expires === undefined || c.expires > t),
  );
  // Genuine host cookies come first and win on a name clash.
  const seen = new Set<string>();
  return toHeader([...genuine, ...rescoped].filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true))));
}

function defaultPath(u: URL): string {
  const p = u.pathname;
  if (!p.startsWith("/") || p.lastIndexOf("/") === 0) return "/";
  return p.slice(0, p.lastIndexOf("/"));
}

/**
 * Apply Set-Cookie headers received from `requestUrl` (e.g. after RotateCookies).
 * Keeps domain/path scoping; deletes on Max-Age<=0 or past Expires; ignores
 * cookies for foreign / non-allowlisted domains.
 */
export function mergeSetCookie(
  jar: CookieJar,
  setCookieHeaders: readonly string[],
  requestUrl: string,
  nowMs: number = Date.now(),
): CookieJar {
  const u = new URL(requestUrl);
  const host = u.hostname.toLowerCase();
  const t = nowSec(nowMs);
  const map = new Map(jar.cookies.map((c) => [key(c), c] as const));

  for (const header of setCookieHeaders) {
    const [pair = "", ...attrs] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) continue;

    let domain = host;
    let path = defaultPath(u);
    let secure = false;
    let httpOnly = false;
    let sameSite: SameSite | undefined;
    let expires: number | undefined;
    let maxAge: number | undefined;
    for (const a of attrs) {
      const i = a.indexOf("=");
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? "" : a.slice(i + 1).trim();
      if (k === "domain" && v) domain = `.${bareDomain(v)}`;
      else if (k === "path" && v.startsWith("/")) path = v;
      else if (k === "secure") secure = true;
      else if (k === "httponly") httpOnly = true;
      else if (k === "samesite") sameSite = normSameSite(v);
      else if (k === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v);
      else if (k === "expires") {
        const ms = Date.parse(v);
        if (!Number.isNaN(ms)) expires = Math.floor(ms / 1000);
      }
    }
    if (maxAge !== undefined) expires = maxAge <= 0 ? 0 : t + maxAge;
    if (!isAllowedDomain(domain) || !domainMatches(host, domain)) continue;

    const c: Cookie = { name, value, domain, path, secure, httpOnly };
    if (expires !== undefined) c.expires = expires;
    if (sameSite) c.sameSite = sameSite;
    if (expires !== undefined && expires <= t) map.delete(key(c));
    else map.set(key(c), c);
  }
  const cookies = [...map.values()];
  if (cookies.length > MAX_COOKIES) throw new JarError("too_many_cookies");
  return { cookies };
}

/** Safe placeholder for a secret value: never reveals content, only its length class. */
export function redact(value: string | undefined | null): string {
  if (!value) return "[empty]";
  return `[redacted:${value.length}]`;
}

export interface JarSummary {
  count: number;
  names: string[];
  domains: Record<string, number>;
  hasRequired: boolean;
}

/** Names and counts only — safe for logs and UI. */
export function jarSummary(jar: CookieJar): JarSummary {
  const domains: Record<string, number> = {};
  for (const c of jar.cookies) domains[c.domain] = (domains[c.domain] ?? 0) + 1;
  const names = [...new Set(jar.cookies.map((c) => c.name))].sort();
  return { count: jar.cookies.length, names, domains, hasRequired: missingRequiredCookies(names).length === 0 };
}
