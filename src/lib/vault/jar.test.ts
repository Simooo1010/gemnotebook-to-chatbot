import { describe, expect, it } from "vitest";
import {
  JarError,
  MAX_COOKIES,
  MAX_VALUE_BYTES,
  cookieHeaderFor,
  isAllowedDomain,
  jarSummary,
  mergeSetCookie,
  parseCookieExport,
  redact,
  type CookieJar,
} from "./jar";

const FUTURE = 4102444800; // 2100-01-01
const NOW = Date.UTC(2026, 9, 30) as number;

const ce = (name: string, domain: string, extra: Record<string, unknown> = {}) => ({
  name,
  value: `fake-${name}-value`,
  domain,
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: !domain.startsWith("."),
  expirationDate: FUTURE + 0.5,
  sameSite: "no_restriction",
  ...extra,
});
const base = () => [ce("SID", ".google.com"), ce("__Secure-1PSIDTS", ".google.com")];

function catchJar(fn: () => unknown): JarError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(JarError);
    return e as JarError;
  }
  throw new Error("expected JarError");
}

describe("isAllowedDomain", () => {
  it.each([".google.com", "google.com", "accounts.google.com", "notebook.google.com", "notebooklm.google.com",
    "drive.google.com", ".googleusercontent.com", "lh3.googleusercontent.com", ".google.co.uk", "google.de", ".google.com.au"])(
    "allows %s", (d) => expect(isAllowedDomain(d)).toBe(true));
  it.each(["evil.com", "google.com.evil.com", "notgoogle.com", "googleusercontent.com.x.io", "google.evil", ""])(
    "rejects %s", (d) => expect(isAllowedDomain(d)).toBe(false));
});

describe("parseCookieExport", () => {
  it("normalises Cookie-Editor shape and drops foreign domains", () => {
    const jar = parseCookieExport([...base(), ce("X", "evil.com"), ce("OSID", "notebook.google.com", { sameSite: "lax" }), ce("NID", ".google.co.uk", { sameSite: "unspecified" })]);
    expect(jar.cookies.map((c) => c.name).sort()).toEqual(["NID", "OSID", "SID", "__Secure-1PSIDTS"]);
    const sid = jar.cookies.find((c) => c.name === "SID")!;
    expect(sid).toEqual({ name: "SID", value: "fake-SID-value", domain: ".google.com", path: "/", secure: true, httpOnly: true, expires: FUTURE, sameSite: "none" });
    const osid = jar.cookies.find((c) => c.name === "OSID")!;
    expect(osid.domain).toBe("notebook.google.com");
    expect(osid.sameSite).toBe("lax");
    expect(jar.cookies.find((c) => c.name === "NID")!.sameSite).toBeUndefined();
  });

  it("accepts a JSON string and {cookies:[...]} wrapper", () => {
    expect(parseCookieExport(JSON.stringify(base())).cookies).toHaveLength(2);
    expect(parseCookieExport({ cookies: base() }).cookies).toHaveLength(2);
  });

  it("reports missing required names only, never values", () => {
    const e = catchJar(() => parseCookieExport([ce("HSID", ".google.com")]));
    expect(e.code).toBe("missing_required");
    expect(e.missing).toEqual(["SID", "__Secure-1PSIDTS"]);
    expect(e.message).not.toContain("fake-");
    const e2 = catchJar(() => parseCookieExport([ce("SID", ".google.com"), ce("__Secure-1PSIDTS", "evil.com")]));
    expect(e2.missing).toEqual(["__Secure-1PSIDTS"]);
  });

  it("rejects non-array input", () => {
    expect(catchJar(() => parseCookieExport("{nope")).code).toBe("invalid_format");
    expect(catchJar(() => parseCookieExport(42)).code).toBe("invalid_format");
  });

  it("caps cookie count and value size", () => {
    const many = [...base(), ...Array.from({ length: MAX_COOKIES }, (_, i) => ce(`C${i}`, ".google.com"))];
    expect(catchJar(() => parseCookieExport(many)).code).toBe("too_many_cookies");
    const big = parseCookieExport([...base(), ce("BIG", ".google.com", { value: "x".repeat(MAX_VALUE_BYTES + 1) })]);
    expect(big.cookies.some((c) => c.name === "BIG")).toBe(false);
  });
});

describe("cookieHeaderFor", () => {
  const jar: CookieJar = {
    cookies: [
      { name: "A", value: "1", domain: ".google.com", path: "/", secure: true, httpOnly: true },
      { name: "H", value: "2", domain: "accounts.google.com", path: "/", secure: false, httpOnly: false },
      { name: "P", value: "3", domain: ".google.com", path: "/notebook", secure: false, httpOnly: false },
      { name: "E", value: "4", domain: ".google.com", path: "/", secure: false, httpOnly: false, expires: 1 },
    ],
  };
  it("matches domain, host-only, path and secure", () => {
    expect(cookieHeaderFor(jar, "https://notebook.google.com/", NOW)).toBe("A=1");
    expect(cookieHeaderFor(jar, "https://notebook.google.com/notebook/abc", NOW)).toBe("P=3; A=1");
    expect(cookieHeaderFor(jar, "https://notebook.google.com/notebookx", NOW)).toBe("A=1");
    expect(cookieHeaderFor(jar, "https://accounts.google.com/x", NOW)).toBe("A=1; H=2");
    expect(cookieHeaderFor(jar, "https://sub.accounts.google.com/", NOW)).toBe("A=1");
    expect(cookieHeaderFor(jar, "http://accounts.google.com/", NOW)).toBe("H=2");
    expect(cookieHeaderFor(jar, "https://google.com.evil.com/", NOW)).toBe("");
  });
});

describe("mergeSetCookie", () => {
  const jar = parseCookieExport(base());
  const url = "https://accounts.google.com/RotateCookies";
  it("updates a value keeping domain/path scoping and adds new host-only cookies", () => {
    const out = mergeSetCookie(jar, [
      "__Secure-1PSIDTS=fake-new; Domain=.google.com; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=3600",
      "LSID=fake-lsid; Path=/; Secure",
    ], url, NOW);
    const ts = out.cookies.filter((c) => c.name === "__Secure-1PSIDTS");
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ value: "fake-new", domain: ".google.com", expires: NOW / 1000 + 3600, sameSite: "none" });
    expect(out.cookies.find((c) => c.name === "LSID")!.domain).toBe("accounts.google.com");
    expect(jar.cookies.find((c) => c.name === "__Secure-1PSIDTS")!.value).toBe("fake-__Secure-1PSIDTS-value");
  });
  it("deletes on Max-Age=0 or past Expires, only in the same scope", () => {
    const out = mergeSetCookie(jar, [
      "SID=; Domain=.google.com; Path=/; Max-Age=0",
      "__Secure-1PSIDTS=; Domain=.google.com; Path=/other; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ], url, NOW);
    expect(out.cookies.map((c) => c.name)).toEqual(["__Secure-1PSIDTS"]);
  });
  it("ignores foreign or non-matching domains", () => {
    const out = mergeSetCookie(jar, ["X=1; Domain=evil.com", "Y=1; Domain=youtube.com", "Z=1; Domain=drive.google.com"], url, NOW);
    expect(out.cookies).toHaveLength(2);
  });
});

describe("redact / jarSummary", () => {
  it("never exposes values", () => {
    expect(redact("fake-secret")).toBe("[redacted:11]");
    expect(redact("")).toBe("[empty]");
    const s = jarSummary(parseCookieExport(base()));
    expect(s).toEqual({ count: 2, names: ["SID", "__Secure-1PSIDTS"], domains: { ".google.com": 2 }, hasRequired: true });
    expect(JSON.stringify(s)).not.toContain("fake-");
  });
});

describe("primary session cookie alternatives", () => {
  it("accepts __Secure-1PSID when the legacy SID is absent (newer Google sessions)", () => {
    const jar = parseCookieExport([ce("__Secure-1PSID", ".google.com"), ce("__Secure-1PSIDTS", ".google.com"), ce("SAPISID", ".google.com")]);
    expect(jar.cookies.map((c) => c.name).sort()).toEqual(["SAPISID", "__Secure-1PSID", "__Secure-1PSIDTS"]);
    expect(jarSummary(jar).hasRequired).toBe(true);
  });
  it("still rejects an export with neither SID nor __Secure-1PSID, naming only SID", () => {
    const e = catchJar(() => parseCookieExport([ce("__Secure-1PSIDTS", ".google.com"), ce("SAPISID", ".google.com")]));
    expect(e.code).toBe("missing_required");
    expect(e.missing).toEqual(["SID"]);
  });
  it("still requires __Secure-1PSIDTS even when __Secure-1PSID is present", () => {
    const e = catchJar(() => parseCookieExport([ce("__Secure-1PSID", ".google.com")]));
    expect(e.code).toBe("missing_required");
    expect(e.missing).toEqual(["__Secure-1PSIDTS"]);
  });
  it("a __Secure-1PSID on a disallowed domain does not count", () => {
    const e = catchJar(() => parseCookieExport([ce("__Secure-1PSID", "evil.com"), ce("__Secure-1PSIDTS", ".google.com")]));
    expect(e.missing).toEqual(["SID"]);
  });
});
