import { cookieHeaderFor, mergeSetCookie, type CookieJar } from "@/lib/vault/jar";
import { DisallowedHostError, ExpiredAuthError, RangeNotSatisfiableError, TooManyRedirectsError } from "./errors";

/** Minimal fetch-compatible surface. Callers MUST pass redirect: "manual". Real `fetch` satisfies it. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal?: AbortSignal;
}
export interface FetchHeaders {
  get(name: string): string | null;
  getSetCookie?(): string[];
}
export interface FetchResponse {
  status: number;
  headers: FetchHeaders;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** Stable desktop Chrome UA (PROTOCOL §1.2: without it Google may omit WIZ_global_data). */
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function browserHeaders(kind: "document" | "xhr" = "document"): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": CHROME_UA,
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (kind === "document") {
    h.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    h["Sec-Fetch-Dest"] = "document";
    h["Sec-Fetch-Mode"] = "navigate";
    h["Sec-Fetch-Site"] = "none";
    h["Sec-Fetch-User"] = "?1";
  } else {
    h.Accept = "*/*";
    h["Sec-Fetch-Dest"] = "empty";
    h["Sec-Fetch-Mode"] = "cors";
    h["Sec-Fetch-Site"] = "same-origin";
  }
  return h;
}

export const DEFAULT_ALLOWED_HOST_SUFFIXES = ["google.com", "googleusercontent.com", "googleapis.com"] as const;

export function isAllowedHost(host: string, suffixes: readonly string[] = DEFAULT_ALLOWED_HOST_SUFFIXES): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

export function setCookiesOf(res: FetchResponse): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

export interface FetchWithJarOptions {
  maxHops?: number;
  /** Host suffixes allowed (exact or subdomain). Default: google.com, googleusercontent.com, googleapis.com. */
  allowedHosts?: readonly string[];
  now?: () => number;
}

export interface FetchWithJarResult {
  response: FetchResponse;
  finalUrl: string;
  jar: CookieJar;
}

function assertAllowed(url: string, allowed: readonly string[]): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DisallowedHostError("invalid");
  }
  if (u.protocol !== "https:" || !isAllowedHost(u.hostname, allowed)) throw new DisallowedHostError(u.hostname);
}

/**
 * Follows redirects manually so cookies are re-attached on every hop (Node fetch drops them cross-origin).
 * The jar is copied, never mutated; Set-Cookie from every hop is merged into the copy.
 */
export async function fetchWithJar(
  fetch: FetchLike,
  jar: CookieJar,
  url: string,
  init: Omit<FetchInit, "redirect"> = {},
  opts: FetchWithJarOptions = {},
): Promise<FetchWithJarResult> {
  const maxHops = opts.maxHops ?? 6;
  const allowed = opts.allowedHosts ?? DEFAULT_ALLOWED_HOST_SUFFIXES;
  const now = opts.now ?? Date.now;
  let current = { cookies: [...jar.cookies] };
  let hopUrl = url;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; ; hop++) {
    assertAllowed(hopUrl, allowed);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const cookie = cookieHeaderFor(current, hopUrl, now());
    if (cookie) headers.Cookie = cookie;
    if (body === undefined) delete headers["Content-Type"];
    const response = await fetch(hopUrl, { method, headers, body, redirect: "manual", signal: init.signal });
    const sc = setCookiesOf(response);
    if (sc.length) current = mergeSetCookie(current, sc, hopUrl, now());
    const loc = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !loc) return { response, finalUrl: hopUrl, jar: current };
    if (hop >= maxHops) throw new TooManyRedirectsError(maxHops);
    hopUrl = new URL(loc, hopUrl).toString();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}

export interface MediaResult {
  /** 200 (whole file) or 206 (the requested byte range). */
  status: number;
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  finalUrl: string;
  jar: CookieJar;
}

/** Streams media. HTML or 0-byte bodies (or non-2xx) are treated as expired auth (SPEC §3 Downloads). */
export async function fetchMedia(
  fetch: FetchLike,
  jar: CookieJar,
  url: string,
  opts: FetchWithJarOptions & { signal?: AbortSignal; range?: string } = {},
): Promise<MediaResult> {
  const { response, finalUrl, jar: out } = await fetchWithJar(
    fetch,
    jar,
    url,
    {
      method: "GET",
      headers: { ...browserHeaders("document"), Accept: "*/*", ...(opts.range ? { Range: opts.range } : {}) },
      signal: opts.signal,
    },
    opts,
  );
  const host = hostOf(finalUrl);
  if (response.status === 416) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeNotSatisfiableError(response.headers.get("content-range"));
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new ExpiredAuthError("http_status", host);
  }
  const contentType = response.headers.get("content-type");
  if (contentType && /text\/html/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ExpiredAuthError("html", host);
  }
  const lenHeader = response.headers.get("content-length");
  const contentLength = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
  if (contentLength === 0 || !response.body) throw new ExpiredAuthError("empty", host);
  // Peek the first non-empty chunk so a 0-byte stream without Content-Length is also rejected.
  const reader = response.body.getReader();
  let first: Uint8Array | undefined;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value && r.value.byteLength > 0) {
      first = r.value;
      break;
    }
  }
  if (!first) throw new ExpiredAuthError("empty", host);
  const head = first;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head);
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return {
    status: response.status,
    body,
    contentType,
    contentLength,
    contentRange: response.headers.get("content-range"),
    acceptRanges: response.headers.get("accept-ranges"),
    finalUrl,
    jar: out,
  };
}

