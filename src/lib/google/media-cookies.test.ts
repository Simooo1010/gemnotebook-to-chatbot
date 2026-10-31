// T3-8 security regressions: the media-only cookie view must stay confined to *.googleusercontent.com media fetches.
import { describe, expect, it } from "vitest";
import { DisallowedHostError } from "./errors";
import { DEFAULT_ALLOWED_HOST_SUFFIXES, fetchMedia, fetchWithJar } from "./http";
import { SYN_SID, res, scriptedFetch, synthJar } from "./testing";
import { cookieHeaderFor, mediaCookieHeaderFor, type CookieJar } from "@/lib/vault/jar";

const MEDIA = "https://lh3.googleusercontent.com/notebooklm/SYNTHETIC1=m140-dv";
const ok = () => res(200, { body: "AUDIOBYTES", headers: { "content-type": "audio/mp4", "content-length": "10" } });

const jarWith = (): CookieJar => {
  const j = synthJar();
  j.cookies.push(
    { name: "OSID", value: "SYN_OSID", domain: ".google.com", path: "/", secure: true, httpOnly: true }, // even domain-wide
    { name: "__Secure-OSID", value: "SYN_SOSID", domain: "notebook.google.com", path: "/", secure: true, httpOnly: true },
    { name: "HOSTONLY", value: "SYN_HO", domain: "notebook.google.com", path: "/", secure: true, httpOnly: true },
    { name: "APISID", value: "SYN_API", domain: ".google.com", path: "/", secure: true, httpOnly: false },
    { name: "EXPIRED", value: "SYN_OLD", domain: ".google.com", path: "/", secure: true, httpOnly: false, expires: 1 },
    { name: "PATHED", value: "SYN_PATH", domain: ".google.com", path: "/other", secure: true, httpOnly: false },
  );
  return j;
};

describe("mediaCookieHeaderFor (media-only view)", () => {
  it("re-scopes domain-wide .google.com cookies onto *.googleusercontent.com, minus OSID, host-only, expired and other-path cookies", () => {
    const h = mediaCookieHeaderFor(jarWith(), MEDIA, Date.now());
    expect(h).toContain(`SID=${SYN_SID}`);
    expect(h).toContain("APISID=SYN_API");
    for (const bad of ["OSID", "__Secure-OSID", "HOSTONLY", "EXPIRED", "PATHED"]) expect(h).not.toContain(`${bad}=`);
  });
  it("a genuine googleusercontent cookie is kept and wins a name clash", () => {
    const j = jarWith();
    j.cookies.push({ name: "SID", value: "GENUINE", domain: ".googleusercontent.com", path: "/", secure: true, httpOnly: true });
    const h = mediaCookieHeaderFor(j, MEDIA, Date.now());
    expect(h).toContain("SID=GENUINE");
    expect(h).not.toContain(`SID=${SYN_SID}`);
  });
  it("is identical to cookieHeaderFor for every other host (google.com, googleapis.com) and for plain http", () => {
    for (const u of ["https://notebook.google.com/x", "https://www.googleapis.com/x", "https://accounts.google.com/"])
      expect(mediaCookieHeaderFor(jarWith(), u, Date.now())).toBe(cookieHeaderFor(jarWith(), u, Date.now()));
    expect(mediaCookieHeaderFor(jarWith(), "http://lh3.googleusercontent.com/x", Date.now())).toBe("");
  });
  it("never applies to look-alike hosts", () => {
    for (const u of ["https://googleusercontent.com.evil.example/x", "https://evilgoogleusercontent.com/x", "https://evil.example/x"])
      expect(mediaCookieHeaderFor(jarWith(), u, Date.now())).toBe("");
  });
});

describe("fetchMedia keeps the view confined", () => {
  it("the normal jar match is unchanged: a plain fetchWithJar to lh3 still sends NO cookies", async () => {
    const { fetch, calls } = scriptedFetch([ok]);
    await fetchWithJar(fetch, jarWith(), MEDIA);
    expect(calls[0]!.init.headers!.Cookie).toBeUndefined();
    expect(cookieHeaderFor(jarWith(), MEDIA)).toBe("");
  });
  it("the returned jar (what the downloader would store in the vault) never contains the re-scoped cookies", async () => {
    const jar = jarWith();
    const before = JSON.stringify(jar);
    const { fetch, calls } = scriptedFetch([ok]);
    const m = await fetchMedia(fetch, jar, MEDIA);
    expect(calls[0]!.init.headers!.Cookie).toContain(`SID=${SYN_SID}`); // the view was used...
    expect(JSON.stringify(jar)).toBe(before); // ...but the input jar is untouched
    expect(JSON.stringify(m.jar)).toBe(before); // ...and so is the one handed back for persistence
    expect(m.jar.cookies.some((c) => /googleusercontent/.test(c.domain))).toBe(false);
  });
  it("redirects re-evaluate the host per hop: view only on the googleusercontent hop, plain match on google.com, never beyond the allow-list", async () => {
    const { fetch, calls } = scriptedFetch([
      () => res(302, { location: "https://notebook.google.com/back" }),
      () => res(302, { location: "https://lh3.googleusercontent.com/again" }),
      () => res(302, { location: "https://evil.example.com/steal" }),
    ]);
    await expect(fetchMedia(fetch, jarWith(), MEDIA)).rejects.toBeInstanceOf(DisallowedHostError);
    expect(calls).toHaveLength(3); // the evil hop was never requested
    expect(calls[0]!.init.headers!.Cookie).not.toContain("HOSTONLY=");
    expect(calls[1]!.url).toBe("https://notebook.google.com/back");
    expect(calls[1]!.init.headers!.Cookie).toContain("HOSTONLY=SYN_HO"); // normal google.com host: plain jar rules
    expect(calls[1]!.init.headers!.Cookie).toContain("OSID=SYN_OSID"); // (OSID is only withheld from download hosts)
    expect(calls[2]!.init.headers!.Cookie).not.toContain("HOSTONLY=");
    expect(calls.some((c) => c.url.includes("evil"))).toBe(false);
  });
  it("a non-Google media URL is refused before any request", async () => {
    const { fetch, calls } = scriptedFetch([ok]);
    await expect(fetchMedia(fetch, jarWith(), "https://lh3.googleusercontent.com.evil.example/x")).rejects.toBeInstanceOf(DisallowedHostError);
    await expect(fetchMedia(fetch, jarWith(), "http://lh3.googleusercontent.com/x")).rejects.toBeInstanceOf(DisallowedHostError);
    expect(calls).toHaveLength(0);
  });
  it("the host allow-list is unchanged", () => {
    expect([...DEFAULT_ALLOWED_HOST_SUFFIXES]).toEqual(["google.com", "googleusercontent.com", "googleapis.com"]);
  });
  it("sends the Referer from the configured base and the cross-site fetch metadata", async () => {
    const { fetch, calls } = scriptedFetch([ok]);
    await fetchMedia(fetch, synthJar(), MEDIA, { base: "https://notebooklm.google.com/" });
    expect(calls[0]!.init.headers).toMatchObject({ Referer: "https://notebooklm.google.com/", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" });
  });
});
