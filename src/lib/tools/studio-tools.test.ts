// Fixtures are SYNTHETIC. Fake ops and a scripted fake fetch; no network.
import type { ChatOps } from "@/lib/notebooklm/chat";
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "@/lib/google/supabase";
import { MemoryUsageCounter } from "@/lib/google/throttle";
import { batchBody, fakeClock, homepageHtml, res, scriptedFetch, synthJar, SYN_SID } from "@/lib/google/testing";
import { MemoryCreatedObjects } from "@/lib/notebooklm/created";
import { handleMediaRequest } from "@/lib/notebooklm/media-download";
import { MediaLinkConfigError, deriveMediaKey, verifyMediaToken } from "@/lib/notebooklm/media-link";
import type { NotebookOps } from "@/lib/notebooklm/notebooks";
import { ArtifactNotReadyError, NEXT_CHECK_SECONDS, NotEnoughReadySourcesError, type StudioOps } from "@/lib/notebooklm/studio";
import type { SourceOps } from "@/lib/notebooklm/sources";
import { RuntimeConfigError, createRuntime, type MediaLinks, type ToolRuntime } from "@/lib/runtime";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import type { Account } from "@/lib/vault/storage";
import { createVault } from "@/lib/vault/vault";
import { createTools } from "./index";

const NB = "00000000-0000-4000-8000-000000000001";
const A1: Account = { id: "a1", label: "Main", emailHash: null, status: "active", createdAt: new Date(0) };
const body = (r: { content: { text: string }[] }) => r.content[0]!.text;
const json = (r: { content: { text: string }[] }) => JSON.parse(body(r)) as Record<string, unknown>;
const GOOGLE_URL = "https://lh3.googleusercontent.com/SECRET_SIGNED_URL_PATH?sig=SECRET_QUERY";

function fake() {
  const studio = {
    createAudioOverview: vi.fn(),
    createVideoOverview: vi.fn(),
    getStudioStatus: vi.fn(),
    getMedia: vi.fn(),
  };
  const links = { create: vi.fn() };
  const rt: ToolRuntime = {
    listAccounts: async () => [A1],
    notebooks: {} as NotebookOps,
    sources: {} as SourceOps,
    studio: studio as unknown as StudioOps,
    chat: {} as ChatOps,
    links: links as unknown as MediaLinks,
    media: {} as never,
  };
  return { tools: createTools(() => rt), studio, links };
}

describe("studio tool definitions", () => {
  const { tools } = fake();
  it("registers creates as non-read-only, non-destructive, non-idempotent, open-world; status and link as read-only", () => {
    for (const t of [tools.studioAudioCreate, tools.studioVideoCreate]) {
      expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    }
    for (const t of [tools.studioStatus, tools.studioDownloadLink]) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect([tools.studioAudioCreate.name, tools.studioVideoCreate.name, tools.studioStatus.name, tools.studioDownloadLink.name]).toEqual([
      "studio_audio_create",
      "studio_video_create",
      "studio_status",
      "studio_download_link",
    ]);
  });

  it("descriptions tell Claude about duration, small free quotas, the polling floor and the next tools", () => {
    for (const t of [tools.studioAudioCreate, tools.studioVideoCreate]) {
      expect(t.description).toMatch(/30 minutes/);
      expect(t.description).toMatch(/Free Google accounts only get a few/);
      expect(t.description).toMatch(new RegExp(`no more often than every ${NEXT_CHECK_SECONDS} seconds`));
      expect(t.description).toMatch(/studio_status/);
      expect(t.description).toMatch(/studio_download_link/);
      expect(t.description).toMatch(/never waits/);
    }
    expect(tools.studioStatus.description).toMatch(/nextCheckInSeconds/);
    expect(tools.studioDownloadLink.description).toMatch(/ready/);
  });

  it("schemas: documented option values only; cinematic/short are not offered; custom needs a prompt", () => {
    const a = tools.studioAudioCreate.inputSchema;
    const v = tools.studioVideoCreate.inputSchema;
    expect(a.safeParse({ notebookId: NB }).data).toMatchObject({ format: "deep_dive", length: "default", language: "en" });
    for (const format of ["deep_dive", "brief", "critique", "debate"]) expect(a.safeParse({ notebookId: NB, format }).success).toBe(true);
    for (const length of ["short", "default", "long"]) expect(a.safeParse({ notebookId: NB, length }).success).toBe(true);
    expect(a.safeParse({ notebookId: NB, format: "interview" }).success).toBe(false);
    expect(a.safeParse({ notebookId: NB, focusPrompt: "x".repeat(2001) }).success).toBe(false);
    expect(a.safeParse({ notebookId: "nope" }).success).toBe(false);
    expect(a.safeParse({ notebookId: NB, sourceIds: ["nope"] }).success).toBe(false);
    expect(v.safeParse({ notebookId: NB }).data).toMatchObject({ format: "explainer", style: "auto", language: "en" });
    for (const style of ["auto", "classic", "whiteboard", "heritage", "paper_craft", "watercolor", "anime", "retro_print", "kawaii"]) {
      expect(v.safeParse({ notebookId: NB, style }).success).toBe(true);
    }
    expect(v.safeParse({ notebookId: NB, style: "custom" }).success).toBe(false);
    expect(v.safeParse({ notebookId: NB, style: "custom", stylePrompt: "neon" }).success).toBe(true);
    expect(v.safeParse({ notebookId: NB, style: "kawaii", stylePrompt: "neon" }).success).toBe(false);
    expect(v.safeParse({ notebookId: NB, style: "custom", stylePrompt: "x".repeat(501) }).success).toBe(false);
    for (const format of ["cinematic", "short"]) expect(v.safeParse({ notebookId: NB, format }).success).toBe(false);
    expect(tools.studioDownloadLink.inputSchema.safeParse({ notebookId: NB, artifactId: "a1", expiresInMinutes: 61 }).success).toBe(false);
    expect(tools.studioDownloadLink.inputSchema.safeParse({ notebookId: NB, artifactId: "a1", expiresInMinutes: 60 }).success).toBe(true);
  });
});

describe("studio tool handlers", () => {
  it("create tools pass options through and return at once with the id, status and polling hint (never waiting)", async () => {
    const { tools, studio } = fake();
    studio.createAudioOverview.mockResolvedValue({ artifactId: "art-A", type: "audio", status: "queued", reconciled: false, sourceCount: 3 });
    studio.createVideoOverview.mockResolvedValue({ artifactId: "art-V", type: "video", status: "generating", reconciled: true, sourceCount: 1 });
    const a = json(await tools.studioAudioCreate.run({ notebookId: NB, format: "debate", length: "long", language: "it", focusPrompt: "f", sourceIds: undefined }));
    expect(studio.createAudioOverview).toHaveBeenCalledWith("a1", NB, { format: "debate", length: "long", language: "it", focusPrompt: "f", sourceIds: undefined });
    expect(a).toMatchObject({ account: { id: "a1" }, notebookId: NB, artifactId: "art-A", type: "audio", status: "queued", nextCheckInSeconds: NEXT_CHECK_SECONDS });
    expect(a.note).toBeUndefined();
    expect(a.next).toMatch(/studio_status/);
    const v = json(await tools.studioVideoCreate.run({ notebookId: NB, format: "brief", style: "custom", stylePrompt: "ink", language: "en" }));
    expect(studio.createVideoOverview).toHaveBeenCalledWith("a1", NB, { format: "brief", style: "custom", stylePrompt: "ink", language: "en" });
    expect(v).toMatchObject({ artifactId: "art-V", type: "video", status: "generating" });
    expect(String(v.note)).toMatch(/nothing was created twice/);
  });

  it("pre-flight refusals and daily caps come back as plain-language isError results", async () => {
    const { tools, studio } = fake();
    studio.createAudioOverview.mockRejectedValue(new NotEnoughReadySourcesError("none_ready", { total: 2, ready: 0 }));
    const r = await tools.studioAudioCreate.run({ notebookId: NB, format: "deep_dive", length: "default", language: "en" });
    expect(r.isError).toBe(true);
    expect(body(r)).toMatch(/Nothing was started[\s\S]*notebook_get/);
  });

  it("studio_status returns the rows, the hint and a plain note", async () => {
    const { tools, studio } = fake();
    const row = { artifactId: "a", type: "audio", title: "T", status: "generating", readyMedia: false, createdAt: null };
    studio.getStudioStatus.mockResolvedValueOnce({ artifacts: [row], total: 1, nextCheckInSeconds: 15 });
    studio.getStudioStatus.mockResolvedValueOnce({ artifacts: [], total: 0, nextCheckInSeconds: 0 });
    const r = json(await tools.studioStatus.run({ notebookId: NB, artifactId: "a", type: "audio" }));
    expect(studio.getStudioStatus).toHaveBeenCalledWith("a1", NB, { artifactId: "a", type: "audio" });
    expect(r).toMatchObject({ artifacts: [row], total: 1, nextCheckInSeconds: 15 });
    expect(String(r.note)).toMatch(/15 seconds or more/);
    expect(String(json(await tools.studioStatus.run({ notebookId: NB })).note)).toMatch(/Nothing is generating/);
  });

  it("studio_download_link verifies readiness, returns our own url + expiry + content type, and never the Google URL", async () => {
    const { tools, studio, links } = fake();
    studio.getMedia.mockResolvedValue({ artifactId: "art-A", kind: "audio", title: "T", url: GOOGLE_URL, mime: "audio/mp4" });
    links.create.mockReturnValue({ url: "https://c.example.com/api/media/TOKEN", expiresAt: new Date(Date.UTC(2026, 9, 30, 12, 15)) });
    const r = await tools.studioDownloadLink.run({ notebookId: NB, artifactId: "art-A", expiresInMinutes: 30 });
    expect(links.create).toHaveBeenCalledWith({ accountId: "a1", notebookId: NB, artifactId: "art-A", kind: "audio", ttlSeconds: 1800 });
    expect(json(r)).toMatchObject({ url: "https://c.example.com/api/media/TOKEN", expiresAt: "2026-10-30T12:15:00.000Z", contentType: "audio/mp4", type: "audio" });
    expect(String(json(r).note)).toMatch(/expires|stops working/);
    expect(body(r)).not.toMatch(/googleusercontent|SECRET/);
    await tools.studioDownloadLink.run({ notebookId: NB, artifactId: "art-A" });
    expect(links.create).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: undefined }));
  });

  it("studio_download_link refuses a not-ready artifact without minting a link", async () => {
    const { tools, studio, links } = fake();
    studio.getMedia.mockRejectedValue(new ArtifactNotReadyError("generating"));
    const r = await tools.studioDownloadLink.run({ notebookId: NB, artifactId: "art-A" });
    expect(r.isError).toBe(true);
    expect(body(r)).toMatch(/not ready yet/);
    expect(links.create).not.toHaveBeenCalled();
  });
});

describe("studio through the real runtime (fake fetch)", () => {
  const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), VAULT_KEY_VERSION: "1" });
  const ENV = { OAUTH_SIGNING_KEY: "k".repeat(48), PUBLIC_BASE_URL: "https://connector.example.com/" };
  const N = null;
  const NOW_SEC = Math.floor(Date.UTC(2026, 9, 30, 12, 0, 0) / 1000);
  const readyAudio = () => {
    const r: unknown[] = Array<unknown>(16).fill(N);
    r[0] = "art-A";
    r[1] = "My overview";
    r[2] = 1;
    r[4] = 3;
    r[6] = [N, N, N, N, N, [[GOOGLE_URL, 1, "audio/mp4"]]];
    r[15] = [NOW_SEC - 600];
    return r;
  };
  const listBody = () => res(200, { body: batchBody("gArtLc", [[readyAudio()]]) });

  async function setup(handlers: Parameters<typeof scriptedFetch>[0], env: Record<string, string | undefined> = ENV) {
    const clock = fakeClock();
    const vault = createVault({ accounts: new MemoryAccountRepo(), sessions: new MemorySessionVault(), keyring });
    await vault.connectAccount("Main", synthJar().cookies);
    const { fetch, calls } = scriptedFetch(handlers);
    const audit = new MemoryAuditSink();
    const rt = createRuntime({ env, vault, created: new MemoryCreatedObjects(), usage: new MemoryUsageCounter(), audit, fetch, now: clock.now, sleep: clock.sleep });
    return { rt, calls, audit, tools: createTools(() => rt), clock };
  }

  it("status -> link -> signed url -> media route streams with a FRESH list, and nothing leaks", async () => {
    const audio = new Uint8Array(64).fill(3);
    const s = await setup([
      () => res(200), // RotateCookies
      () => res(200, { body: homepageHtml() }),
      listBody, // studio_status
      listBody, // studio_download_link re-check
      listBody, // media route: fresh list
      () => res(200, { body: audio as unknown as string, headers: { "content-type": "audio/mp4", "content-length": "64" } }), // media bytes
    ]);

    const st = json(await s.tools.studioStatus.run({ notebookId: NB }));
    expect(st).toMatchObject({ artifacts: [{ artifactId: "art-A", type: "audio", status: "ready", readyMedia: true, title: "My overview" }], nextCheckInSeconds: 0 });
    expect(JSON.stringify(st)).not.toMatch(/googleusercontent|SECRET/);

    const link = await s.tools.studioDownloadLink.run({ notebookId: NB, artifactId: "art-A" });
    const l = json(link);
    expect(String(l.url)).toMatch(/^https:\/\/connector\.example\.com\/api\/media\/[A-Za-z0-9_.-]+$/);
    expect(body(link)).not.toMatch(/googleusercontent|SECRET|SYNTHETIC_SID/);
    const token = String(l.url).split("/").pop()!;
    const claims = verifyMediaToken(deriveMediaKey(ENV), token, s.clock.now);
    expect(claims).toMatchObject({ notebookId: NB, artifactId: "art-A", kind: "audio" });
    const left = Date.parse(String(l.expiresAt)) - s.clock.now();
    expect(left).toBeGreaterThan(14 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);

    const r = await handleMediaRequest(new Request(String(l.url)), token, { key: () => deriveMediaKey(ENV), downloader: () => s.rt.media, now: s.clock.now });
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(64);
    const last = s.calls.at(-1)!;
    expect(last.url).toBe(GOOGLE_URL); // the fresh URL from the re-list, used only server side
    expect(last.init.headers!.Cookie).toBeUndefined(); // the synthetic jar only has .google.com cookies: none goes to googleusercontent.com
    expect(s.calls[2]!.init.headers!.Cookie).toContain(`SID=${SYN_SID}`); // ...while the notebook.google.com list call carried them
    expect(s.audit.rows.map((x) => x.tool)).toContain("media_download");
    expect(JSON.stringify(s.audit.rows)).not.toMatch(/SECRET|googleusercontent|SID/);
  });

  it("links need PUBLIC_BASE_URL and OAUTH_SIGNING_KEY; missing ones fail closed with config errors", async () => {
    const a = await setup([], { OAUTH_SIGNING_KEY: "k".repeat(48) });
    expect(() => a.rt.links.create({ accountId: "a", notebookId: NB, artifactId: "x", kind: "audio" })).toThrow(RuntimeConfigError);
    const b = await setup([], { PUBLIC_BASE_URL: "https://c.example.com" });
    expect(() => b.rt.links.create({ accountId: "a", notebookId: NB, artifactId: "x", kind: "audio" })).toThrow(MediaLinkConfigError);
    const c = await setup([], { OAUTH_SIGNING_KEY: "k".repeat(48), PUBLIC_BASE_URL: "http://evil.example.com" });
    expect(() => c.rt.links.create({ accountId: "a", notebookId: NB, artifactId: "x", kind: "audio" })).toThrow(RuntimeConfigError);
  });
});
