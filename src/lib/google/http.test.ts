import { describe, expect, it } from "vitest";
import { DisallowedHostError, ExpiredAuthError, TooManyRedirectsError } from "./errors";
import { fetchMedia, fetchWithJar } from "./http";
import { SYN_SID, res, scriptedFetch, synthJar } from "./testing";

describe("fetchWithJar", () => {
  it("re-attaches cookies on every hop and merges Set-Cookie between hops", async () => {
    const { fetch, calls } = scriptedFetch([
      () => res(302, { location: "https://lh3.googleusercontent.com/a", setCookie: ["NEWC=hop1; Domain=.google.com; Path=/; Secure"] }),
      () => res(302, { location: "https://notebook.google.com/final" }),
      () => res(200, { body: "ok" }),
    ]);
    const out = await fetchWithJar(fetch, synthJar(), "https://notebook.google.com/start");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.init.headers!.Cookie).toContain(`SID=${SYN_SID}`);
    expect(calls[0]!.init.headers!.Cookie).not.toContain("NEWC");
    // googleusercontent.com does not domain-match .google.com cookies
    expect(calls[1]!.init.headers!.Cookie).toBeUndefined();
    expect(calls[2]!.init.headers!.Cookie).toContain("NEWC=hop1");
    expect(calls[2]!.init.headers!.Cookie).toContain(`SID=${SYN_SID}`);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
    expect(out.finalUrl).toBe("https://notebook.google.com/final");
    expect(out.jar.cookies.some((c) => c.name === "NEWC")).toBe(true);
  });

  it("refuses cross-host redirects and never sends cookies there", async () => {
    const { fetch, calls } = scriptedFetch([() => res(302, { location: "https://evil.example.com/x" })]);
    await expect(fetchWithJar(fetch, synthJar(), "https://notebook.google.com/")).rejects.toBeInstanceOf(DisallowedHostError);
    expect(calls).toHaveLength(1);
    await expect(fetchWithJar(fetch, synthJar(), "https://google.com.evil.example/")).rejects.toBeInstanceOf(DisallowedHostError);
    await expect(fetchWithJar(fetch, synthJar(), "http://notebook.google.com/")).rejects.toBeInstanceOf(DisallowedHostError);
  });

  it("stops after maxHops", async () => {
    const loop = () => res(302, { location: "https://notebook.google.com/loop" });
    const { fetch } = scriptedFetch(Array.from({ length: 10 }, () => loop));
    await expect(fetchWithJar(fetch, synthJar(), "https://notebook.google.com/", {}, { maxHops: 2 })).rejects.toBeInstanceOf(
      TooManyRedirectsError,
    );
  });

  it("turns POST into GET on 302", async () => {
    const { fetch, calls } = scriptedFetch([() => res(302, { location: "/next" }), () => res(200)]);
    await fetchWithJar(fetch, synthJar(), "https://accounts.google.com/x", { method: "POST", body: "b" });
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.init.body).toBeUndefined();
  });
});

describe("fetchMedia", () => {
  it("rejects HTML as expired auth", async () => {
    const { fetch } = scriptedFetch([() => res(200, { body: "<html>", headers: { "content-type": "text/html; charset=utf-8" } })]);
    await expect(fetchMedia(fetch, synthJar(), "https://lh3.googleusercontent.com/m")).rejects.toMatchObject({ reason: "html" });
  });
  it("rejects empty bodies (with and without content-length)", async () => {
    const a = scriptedFetch([() => res(200, { body: "", headers: { "content-type": "audio/mp4", "content-length": "0" } })]);
    await expect(fetchMedia(a.fetch, synthJar(), "https://lh3.googleusercontent.com/m")).rejects.toBeInstanceOf(ExpiredAuthError);
    const b = scriptedFetch([() => res(200, { body: "", headers: { "content-type": "audio/mp4" } })]);
    await expect(fetchMedia(b.fetch, synthJar(), "https://lh3.googleusercontent.com/m")).rejects.toMatchObject({ reason: "empty" });
  });
  it("returns the full stream, type and length", async () => {
    const { fetch } = scriptedFetch([
      () => res(302, { location: "https://lh3.googleusercontent.com/real" }),
      () => res(200, { body: "MEDIABYTES", headers: { "content-type": "video/mp4", "content-length": "10" } }),
    ]);
    const m = await fetchMedia(fetch, synthJar(), "https://notebook.google.com/dl");
    expect(m.contentType).toBe("video/mp4");
    expect(m.contentLength).toBe(10);
    expect(await new Response(m.body).text()).toBe("MEDIABYTES");
  });
});
