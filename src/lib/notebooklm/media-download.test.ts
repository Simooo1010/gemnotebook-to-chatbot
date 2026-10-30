// Fixtures are SYNTHETIC. The Google side is a scripted fake fetch; no network.
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "@/lib/google/supabase";
import { SYN_SID, fakeClock, res, scriptedFetch, synthJar, type Handler } from "@/lib/google/testing";
import { createThrottle } from "@/lib/google/throttle";
import type { CookieJar } from "@/lib/vault/jar";
import { VaultError } from "@/lib/vault/vault";
import { createMediaDownloader, handleMediaRequest, sanitizeRange } from "./media-download";
import { deriveMediaKey, signMediaToken, type MediaClaims, type MediaKind } from "./media-link";
import { ArtifactNotFoundError, ArtifactNotReadyError, type MediaTarget } from "./studio";

const ENV = { OAUTH_SIGNING_KEY: "k".repeat(48) };
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const key = deriveMediaKey(ENV);
const ACCOUNT = "account-id-SENSITIVE-1";
const NBK = "00000000-0000-4000-8000-000000000001";
const SIGNED_URL = "https://lh3.googleusercontent.com/SECRET_SIGNED_URL_PATH/dv?sig=SECRET_QUERY";
const CLAIMS: MediaClaims = { accountId: ACCOUNT, notebookId: NBK, artifactId: "art-1", kind: "audio" };
const tokenFor = (c: MediaClaims = CLAIMS, ttl?: number) => signMediaToken(key, c, { now: () => NOW, ttlSeconds: ttl }).token;
const bytes = (n: number) => new Uint8Array(n).fill(7);
const jarWith = (extra: CookieJar["cookies"] = []): CookieJar => ({ cookies: [...synthJar().cookies, ...extra] });

interface Opts {
  target?: MediaTarget | Error;
  jar?: CookieJar | Error;
  handlers: Handler[];
}
function setup(o: Opts) {
  const clock = fakeClock(NOW);
  const audit = new MemoryAuditSink();
  const { fetch, calls } = scriptedFetch(o.handlers);
  const getMedia = vi.fn(async () => {
    if (o.target instanceof Error) throw o.target;
    return o.target ?? { artifactId: "art-1", kind: "audio" as MediaKind, title: "T", url: SIGNED_URL, mime: "audio/mp4" };
  });
  const updateJar = vi.fn(async () => undefined);
  const downloader = createMediaDownloader({
    studio: { getMedia },
    vault: {
      getJar: async () => {
        if (o.jar instanceof Error) throw o.jar;
        return o.jar ?? jarWith();
      },
      updateJar,
    },
    throttle: createThrottle({ now: clock.now, sleep: clock.sleep, random: () => 0 }),
    fetch,
    audit,
    now: clock.now,
  });
  const call = (token: string, init: RequestInit = {}) =>
    handleMediaRequest(new Request(`https://connector.example.com/api/media/${token}`, init), token, { key: () => key, downloader: () => downloader, now: clock.now });
  return { call, calls, audit, getMedia, updateJar };
}
const get = (h: Record<string, string> = {}): RequestInit => ({ method: "GET", headers: h });

async function dump(r: Response): Promise<string> {
  const h = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return `${r.status}\n${h}\n${await r.clone().text()}`;
}
const LEAKS = [SIGNED_URL, "SECRET_SIGNED_URL_PATH", "SECRET_QUERY", "googleusercontent", SYN_SID, ACCOUNT, "SYNTHETIC_PSIDTS_VALUE_x2"];
const expectNoLeak = (text: string) => {
  for (const l of LEAKS) expect(text).not.toContain(l);
};

describe("sanitizeRange", () => {
  it("forwards only a single, well-formed byte range", () => {
    for (const ok of ["bytes=0-1", "bytes=100-", "bytes=-500", " bytes=5-9 "]) expect(sanitizeRange(ok)).toBe(ok.trim());
    for (const bad of ["bytes=0-1,5-9", "items=0-1", "bytes=a-b", "bytes=", "bytes=0-1\r\nX: y", "", null]) expect(sanitizeRange(bad)).toBeUndefined();
  });
});

describe("GET /api/media/<token>: refusals are generic", () => {
  it("bad, expired, tampered, empty tokens -> the same 404, no upstream call", async () => {
    const s = setup({ handlers: [] });
    const good = tokenFor();
    const [body, sig] = good.split(".") as [string, string];
    const expired = signMediaToken(key, CLAIMS, { now: () => NOW - 2 * 3600_000, ttlSeconds: 60 }).token;
    const results = await Promise.all(["x", "a.b", expired, `${body}.${sig.slice(0, -3)}AAA`, `${body}x.${sig}`, "e".repeat(5000)].map((t) => s.call(t, get())));
    const dumps = await Promise.all(results.map(dump));
    for (const d of dumps) expect(d).toBe(dumps[0]);
    expect(results[0]!.status).toBe(404);
    expect(await results[0]!.text()).toBe("Not found");
    expect(s.calls).toHaveLength(0);
    expect(s.getMedia).not.toHaveBeenCalled();
  });

  it("a token signed with a different key or context is refused", async () => {
    const s = setup({ handlers: [] });
    for (const k of [deriveMediaKey(ENV, "owner-session"), deriveMediaKey({ OAUTH_SIGNING_KEY: "z".repeat(48) })]) {
      const t = signMediaToken(k, CLAIMS, { now: () => NOW }).token;
      expect((await s.call(t, get())).status).toBe(404);
    }
    expect(s.getMedia).not.toHaveBeenCalled();
  });

  it("non-active / unknown / wiped accounts, missing or not-ready artifacts -> the same generic 404", async () => {
    const errors = [new VaultError("not_active"), new VaultError("not_found"), new VaultError("no_session"), new ArtifactNotFoundError(), new ArtifactNotReadyError("generating")];
    const dumps: string[] = [];
    for (const e of errors) {
      const s = setup({ target: e, handlers: [] });
      const r = await s.call(tokenFor(), get());
      expect(r.status).toBe(404);
      dumps.push(await dump(r));
      expectNoLeak(dumps.at(-1)!);
      expect(s.calls).toHaveLength(0);
    }
    for (const d of dumps) expect(d).toBe(dumps[0]);
    const inactive = setup({ jar: new VaultError("not_active"), handlers: [] });
    expect((await inactive.call(tokenFor(), get())).status).toBe(404);
  });

  it("the artifact kind must match the token's kind", async () => {
    const s = setup({ target: { artifactId: "art-1", kind: "video", title: null, url: SIGNED_URL, mime: "video/mp4" }, handlers: [] });
    expect((await s.call(tokenFor(), get())).status).toBe(404);
  });

  it("only GET is served; missing signing key / storage -> generic 503", async () => {
    const s = setup({ handlers: [] });
    expect((await s.call(tokenFor(), { method: "POST" })).status).toBe(405);
    const r = await handleMediaRequest(new Request("https://c.example.com/api/media/x"), "x", {
      key: () => {
        throw new Error("OAUTH_SIGNING_KEY secret-ish");
      },
      downloader: () => {
        throw new Error("x");
      },
    });
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("Service unavailable");
  });
});

describe("GET /api/media/<token>: streaming", () => {
  const audioOk = (extra: Record<string, string> = {}, status = 200, n = 1000) => () =>
    res(status, { body: bytes(n) as unknown as string, headers: { "content-type": "audio/mp4", "content-length": String(n), ...extra } });

  it("streams a fresh media URL with the cookie jar; sets type, disposition, no-store, no-referrer; audits outcome only", async () => {
    const s = setup({ handlers: [audioOk({ "accept-ranges": "bytes" })] });
    const r = await s.call(tokenFor(), get());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mp4");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="overview.m4a"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("1000");
    expect((await r.arrayBuffer()).byteLength).toBe(1000);
    expect(s.getMedia).toHaveBeenCalledWith(ACCOUNT, NBK, "art-1", "media_download"); // fresh lookup on every request
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(SIGNED_URL);
    expect(s.calls[0]!.init.redirect).toBe("manual");
    expect(s.audit.rows.map((x) => [x.tool, x.outcome, x.accountId])).toEqual([["media_download", "ok", ACCOUNT]]);
    expect(JSON.stringify(s.audit.rows)).not.toMatch(/SECRET|googleusercontent|SID/);
  });

  it("video is served as video/mp4 inline overview.mp4", async () => {
    const target: MediaTarget = { artifactId: "v-1", kind: "video", title: null, url: SIGNED_URL, mime: "video/mp4" };
    const s = setup({ target, handlers: [() => res(200, { body: bytes(10) as unknown as string, headers: { "content-type": "video/mp4", "content-length": "10" } })] });
    const r = await s.call(tokenFor({ ...CLAIMS, artifactId: "v-1", kind: "video" }), get());
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="overview.mp4"');
  });

  it("forwards Range and answers 206 with Content-Range / Accept-Ranges / Content-Length (iPhone Safari video)", async () => {
    const s = setup({ handlers: [audioOk({ "content-range": "bytes 0-99/5000", "accept-ranges": "bytes" }, 206, 100)] });
    const r = await s.call(tokenFor(), get({ Range: "bytes=0-99" }));
    expect(s.calls[0]!.init.headers!.Range).toBe("bytes=0-99");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-99/5000");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("100");
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  });

  it("open-ended and suffix ranges pass through; a malformed or multi-range header is not forwarded", async () => {
    for (const range of ["bytes=100-", "bytes=-500"]) {
      const s = setup({ handlers: [audioOk({ "content-range": "bytes 100-199/200" }, 206, 100)] });
      await s.call(tokenFor(), get({ Range: range }));
      expect(s.calls[0]!.init.headers!.Range).toBe(range);
    }
    for (const range of ["bytes=0-1,5-9", "garbage"]) {
      const s = setup({ handlers: [audioOk()] });
      const r = await s.call(tokenFor(), get({ Range: range }));
      expect(s.calls[0]!.init.headers!.Range).toBeUndefined();
      expect(r.status).toBe(200);
    }
  });

  it("an upstream that ignores Range (200) is not advertised as seekable", async () => {
    const s = setup({ handlers: [audioOk()] });
    const r = await s.call(tokenFor(), get({ Range: "bytes=0-9" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("none");
    expect(r.headers.get("content-range")).toBeNull();
  });

  it("upstream 416 is passed on as 416 with its Content-Range", async () => {
    const s = setup({ handlers: [() => res(416, { headers: { "content-range": "bytes */5000" } })] });
    const r = await s.call(tokenFor(), get({ Range: "bytes=9999-" }));
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */5000");
    expect(s.audit.rows[0]!.outcome).toBe("error:range_not_satisfiable");
  });

  describe("expired Google auth -> generic 502, nothing leaked", () => {
    const cases: [string, Handler][] = [
      ["HTML login page", () => res(200, { body: "<html>Sign in https://accounts.google.com/?sig=SECRET_QUERY</html>", headers: { "content-type": "text/html; charset=utf-8" } })],
      ["0-byte body", () => res(200, { body: "", headers: { "content-type": "audio/mp4", "content-length": "0" } })],
      ["403", () => res(403, { body: "denied SECRET_QUERY" })],
      ["500", () => res(500)],
    ];
    it.each(cases)("%s", async (_n, h) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const s = setup({ handlers: [h] });
      const r = await s.call(tokenFor(), get());
      expect(r.status).toBe(502);
      const d = await dump(r);
      expectNoLeak(d);
      expect(d).toContain("could not be fetched");
      expect(s.audit.rows[0]!.outcome).toBe("error:expired_auth");
      expectNoLeak(spy.mock.calls.flat().join(" "));
      expect(spy.mock.calls.flat().join(" ")).toContain("error:expired_auth");
      spy.mockRestore();
    });
  });

  describe("redirects: cookies only to Google hosts, re-attached on every hop", () => {
    it("google.com -> googleusercontent.com keeps the right cookies per host and streams the final body", async () => {
      const jar = jarWith([{ name: "LH3", value: "LH3_COOKIE_VALUE", domain: ".googleusercontent.com", path: "/", secure: true, httpOnly: true }]);
      const s = setup({
        jar,
        target: { artifactId: "art-1", kind: "audio", title: null, url: "https://notebook.google.com/media/x", mime: "audio/mp4" },
        handlers: [
          () => res(302, { location: "https://lh3.googleusercontent.com/final/dv", setCookie: ["HOP=hop1; Domain=.google.com; Path=/; Secure"] }),
          audioOk(),
        ],
      });
      const r = await s.call(tokenFor(), get());
      expect(r.status).toBe(200);
      expect(s.calls).toHaveLength(2);
      const first = s.calls[0]!.init.headers!.Cookie!;
      const second = s.calls[1]!.init.headers!.Cookie!;
      expect(first).toContain(`SID=${SYN_SID}`);
      expect(first).not.toContain("LH3_COOKIE_VALUE"); // googleusercontent cookie never goes to google.com
      expect(second).toContain("LH3_COOKIE_VALUE");
      expect(second).not.toContain(`SID=${SYN_SID}`); // google.com cookies never go to googleusercontent.com
      await r.arrayBuffer();
    });

    it("a redirect to a non-Google host is refused before any request or cookie goes there; client sees a generic 502", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const s = setup({
        target: { artifactId: "art-1", kind: "audio", title: null, url: "https://notebook.google.com/media/x", mime: "audio/mp4" },
        handlers: [() => res(302, { location: "https://evil.example/steal?c=1" })],
      });
      const r = await s.call(tokenFor(), get());
      expect(r.status).toBe(502);
      expect(s.calls).toHaveLength(1); // never requested evil.example
      expect(s.calls.every((c) => new URL(c.url).hostname.endsWith("google.com"))).toBe(true);
      expect(await dump(r)).not.toContain("evil.example");
      expect(s.audit.rows[0]!.outcome).toBe("error:disallowed_host");
      spy.mockRestore();
    });

    it("rotated cookies from Set-Cookie are saved back to the vault; an unchanged jar is not rewritten", async () => {
      const a = setup({
        target: { artifactId: "art-1", kind: "audio", title: null, url: "https://notebook.google.com/media/x", mime: "audio/mp4" },
        handlers: [() => res(200, { body: bytes(5) as unknown as string, headers: { "content-type": "audio/mp4", "content-length": "5" }, setCookie: ["SID=ROTATED_VALUE; Domain=.google.com; Path=/; Secure"] })],
      });
      await (await a.call(tokenFor(), get())).arrayBuffer();
      expect(a.updateJar).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(a.updateJar.mock.calls[0])).toContain("ROTATED_VALUE");
      const b = setup({ handlers: [audioOk()] });
      await (await b.call(tokenFor(), get())).arrayBuffer();
      expect(b.updateJar).not.toHaveBeenCalled();
    });
  });

  it("the stream is not buffered: a body that errors midway ends the response without leaking", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(10));
      },
      pull(c) {
        c.error(new Error("socket reset SECRET_QUERY"));
      },
    });
    const s = setup({ handlers: [() => new Response(stream, { status: 200, headers: { "content-type": "audio/mp4" } })] });
    const r = await s.call(tokenFor(), get());
    expect(r.status).toBe(200);
    expectNoLeak(await dump(new Response(null, { status: r.status, headers: r.headers })));
    await r.arrayBuffer().catch(() => undefined);
  });
});
