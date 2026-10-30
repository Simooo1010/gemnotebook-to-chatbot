import { describe, expect, it } from "vitest";
import { CookieMismatchError, RegionGateError, SignedOutError } from "./errors";
import { createTokenCache, fetchPageTokens } from "./session";
import { SYN_AT, SYN_SID, fakeClock, homepageHtml, res, scriptedFetch, synthJar } from "./testing";

const base = "https://notebook.google.com";

describe("fetchPageTokens", () => {
  it("ok: extracts tokens, sends cookies + browser UA, merges Set-Cookie", async () => {
    const { fetch, calls } = scriptedFetch([
      () => res(302, { location: "https://notebook.google.com/?hl=en&pli=1", setCookie: ["NID=n1; Domain=.google.com; Path=/"] }),
      () => res(200, { body: homepageHtml() }),
    ]);
    const r = await fetchPageTokens({ fetch, jar: synthJar(), base });
    expect(r.status).toBe("ok");
    expect(r.tokens.at).toBe(SYN_AT);
    expect(r.tokens.fsid).toBe("-1234567890123456789");
    expect(calls[0]!.url).toBe("https://notebook.google.com/?hl=en");
    expect(calls[0]!.init.headers!["User-Agent"]).toMatch(/Chrome/);
    expect(calls[1]!.init.headers!.Cookie).toContain("NID=n1");
    expect(r.jar.cookies.some((c) => c.name === "NID")).toBe(true);
  });

  const cases: [string, () => Response[], unknown][] = [
    ["signed_out (accounts redirect)", () => [res(302, { location: "https://accounts.google.com/ServiceLogin?x=1" }), res(200, { body: "<html>login</html>" })], SignedOutError],
    ["signed_out (landing page)", () => [res(200, { body: '<div class="landing-header-signin">' })], SignedOutError],
    ["region_gate", () => [res(302, { location: "https://notebook.google.com/?location=unsupported" }), res(200, { body: "x" })], RegionGateError],
    ["cookie_mismatch", () => [res(302, { location: "https://accounts.google.com/CookieMismatch" }), res(200, { body: "x" })], CookieMismatchError],
  ];
  for (const [name, mk, cls] of cases) {
    it(name, async () => {
      const { fetch } = scriptedFetch(mk().map((r) => () => r));
      const p = fetchPageTokens({ fetch, jar: synthJar(), base });
      await expect(p).rejects.toBeInstanceOf(cls as never);
      const e = (await p.catch((x: unknown) => x)) as Error;
      expect(e.message).not.toContain(SYN_SID);
      expect(e.message).not.toContain("login");
    });
  }

  it("token cache expires after TTL", () => {
    const clock = fakeClock();
    const c = createTokenCache({ now: clock.now, ttlMs: 1000 });
    c.set("a", { at: "x", fsid: "1", bl: null });
    expect(c.get("a")).not.toBeNull();
    clock.advance(1000);
    expect(c.get("a")).toBeNull();
  });
});
