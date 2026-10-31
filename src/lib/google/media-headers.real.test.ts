// Differential tests (tester 3) vs jacob-bd/notebooklm-mcp-cli src/notebooklm_tools/core/{download.py,base.py} (read, not executed).
// `it.fails` = CURRENT DEFECT (report finding T3-7 / T3-8). Flip to `it` when fixed.
import { describe, expect, it } from "vitest";
import { fetchMedia } from "./http";
import { res, scriptedFetch, synthJar } from "./testing";

const MEDIA = "https://lh3.googleusercontent.com/notebooklm/SYNTHETIC1=m140-dv";
const ok = () => res(200, { body: "AUDIOBYTES", headers: { "content-type": "audio/mp4", "content-length": "10" } });

describe("media download request vs CLI (live-found rules)", () => {
  it.fails("T3-7: sends Referer {base}/ and Sec-Fetch-Site: cross-site (CLI: 'none' makes the audio CDN answer 403)", async () => {
    const { fetch, calls } = scriptedFetch([ok]);
    await fetchMedia(fetch, synthJar(), MEDIA);
    const h = calls[0]!.init.headers!;
    expect(h["Sec-Fetch-Site"]).toBe("cross-site");
    expect(h.Referer).toMatch(/^https:\/\/notebook(lm)?\.google\.com\/$/);
  });
  it.fails("T3-8: .google.com session cookies are also sent to lh3.googleusercontent.com (CLI duplicates them onto .googleusercontent.com), but never OSID", async () => {
    const jar = synthJar();
    jar.cookies.push({ name: "OSID", value: "SYN_OSID", domain: "notebook.google.com", path: "/", secure: true, httpOnly: true });
    const { fetch, calls } = scriptedFetch([ok]);
    await fetchMedia(fetch, jar, MEDIA);
    const cookie = calls[0]!.init.headers!.Cookie ?? "";
    expect(cookie).toContain("SID=");
    expect(cookie).not.toContain("OSID=");
  });
});
