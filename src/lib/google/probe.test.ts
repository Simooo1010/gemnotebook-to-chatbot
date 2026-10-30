import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/probe/google/route";
import { bearerMatches, runGoogleProbe } from "./probe";
import { SYN_AT, SYN_SID, homepageHtml, res, scriptedFetch, type Handler } from "./testing";

const ok: Handler = () => res(200, { body: homepageHtml() });

describe("runGoogleProbe", () => {
  it("healthy datacenter IP: redirect to accounts.google.com = signed_out; metadata only, query stripped", async () => {
    const f = scriptedFetch([
      () => res(302, { location: "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fnotebook.google.com%2F&secret=abc" }),
      () => res(200, { body: "<html>SECRET BODY</html>" }),
    ]);
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r).toEqual({
      classification: "signed_out",
      finalHost: "accounts.google.com",
      finalPath: "/v3/signin/identifier",
      status: 200,
      hopHosts: ["notebook.google.com", "accounts.google.com"],
    });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|continue|abc/);
    expect(f.calls[0]!.url).toBe("https://notebook.google.com/?hl=en");
    expect(f.calls[0]!.init.redirect).toBe("manual");
    expect(f.calls[0]!.init.headers!.Cookie).toBeUndefined();
    expect(f.calls[0]!.init.headers!["User-Agent"]).toMatch(/Chrome/);
  });

  it("gate: location=unsupported → region_gate", async () => {
    const f = scriptedFetch([() => res(302, { location: "https://notebooklm.google.com/?location=unsupported" }), () => res(200, { body: "x" })]);
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r.classification).toBe("region_gate");
    expect(r.finalPath).toBe("/");
    expect(r.hopHosts).toEqual(["notebook.google.com", "notebooklm.google.com"]);
  });

  it("uses NOTEBOOKLM_BASE_URL when given", async () => {
    const f = scriptedFetch([() => res(200, { body: "<html>landing-header-signin</html>" })]);
    const r = await runGoogleProbe({ fetch: f.fetch, base: "https://notebooklm.google.com/" });
    expect(f.calls[0]!.url).toBe("https://notebooklm.google.com/?hl=en");
    expect(r.classification).toBe("signed_out");
  });

  it("refuses non-Google hops without fetching them", async () => {
    const f = scriptedFetch([() => res(302, { location: "https://evil.example.com/x?y=1" })]);
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r).toMatchObject({ classification: "unknown", error: "disallowed_host", finalHost: "evil.example.com", hopHosts: ["notebook.google.com"] });
    expect(f.calls).toHaveLength(1);
    expect((await runGoogleProbe({ fetch: scriptedFetch([]).fetch, base: "http://notebook.google.com" })).error).toBe("disallowed_host");
    expect((await runGoogleProbe({ fetch: scriptedFetch([]).fetch, base: "https://example.com" })).error).toBe("disallowed_host");
  });

  it("stops after 6 hops", async () => {
    const loop: Handler = () => res(302, { location: "https://accounts.google.com/loop" });
    const f = scriptedFetch(Array.from({ length: 8 }, () => loop));
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r.error).toBe("too_many_redirects");
    expect(f.calls).toHaveLength(7); // initial + 6 hops
  });

  it("network failure is reported, not thrown", async () => {
    const f = scriptedFetch([
      () => {
        throw new TypeError("fetch failed: secret detail");
      },
    ]);
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r).toMatchObject({ classification: "unknown", error: "network", status: 0 });
    expect(JSON.stringify(r)).not.toContain("secret detail");
  });

  it("a page that carries tokens classifies ok (and never leaks them)", async () => {
    const f = scriptedFetch([ok]);
    const r = await runGoogleProbe({ fetch: f.fetch });
    expect(r.classification).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(SYN_AT);
    expect(JSON.stringify(r)).not.toContain(SYN_SID);
  });
});

describe("bearerMatches", () => {
  it("accepts only the exact bearer secret; fails closed when unset/empty", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer s3cret!", "s3cret")).toBe(false);
    expect(bearerMatches("bearer s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
    expect(bearerMatches(null, "s3cret")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer x", undefined)).toBe(false);
    expect(bearerMatches("Bearer undefined", undefined)).toBe(false);
  });
});

describe("GET /api/probe/google", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const req = (auth?: string) => new Request("http://localhost/api/probe/google", { headers: auth ? { authorization: auth } : {} });

  it("503 when CRON_SECRET is unset, and no outbound call is made", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await GET(req("Bearer anything"));
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(spy).not.toHaveBeenCalled();
  });

  it("401 without or with a wrong bearer, no outbound call", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("200 with metadata only for the right bearer", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("NOTEBOOKLM_BASE_URL", "");
    const spy = vi.fn(async (url: string) =>
      url.startsWith("https://notebook.google.com")
        ? res(302, { location: "https://accounts.google.com/ServiceLogin?x=1" })
        : res(200, { body: "BODY-MUST-NOT-LEAK" }),
    );
    vi.stubGlobal("fetch", spy);
    const r = await GET(req("Bearer s3cret"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      classification: "signed_out",
      finalHost: "accounts.google.com",
      finalPath: "/ServiceLogin",
      status: 200,
      hopHosts: ["notebook.google.com", "accounts.google.com"],
    });
    expect(text).not.toContain("BODY-MUST-NOT-LEAK");
  });
});
