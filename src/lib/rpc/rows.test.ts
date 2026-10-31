// SYNTHETIC fixture built from docs/PROTOCOL.md; replace with real capture in the real-data run
import { describe, expect, it } from "vitest";
import { parseChatResponse } from "./chat";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "./errors";
import * as R from "./rows";

const N = null;
const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const nbRow: unknown[] = ["thought\nMy NB", N, U1, "📘", N, [1, N, N, N, N, [1700000000], N, N, [1690000000]]];
const srcRow = (status: number) => [[U2], "Doc", [N, 120, [1690000000], N, 5, N, N, ["https://x.y"]], [N, status]];

describe("rows", () => {
  it("safeIndex reports only the path", () => {
    try {
      R.safeIndex([["secret"]], [0, 3], "rLM1Ne");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RpcDriftError);
      expect((e as Error).message).toContain("[0][3]");
      expect((e as Error).message).not.toContain("secret");
    }
  });
  it("notebook list", () => {
    expect(R.decodeNotebookList([[nbRow]], "wXbhsf")).toEqual([
      { id: U1, title: "My NB", emoji: "📘", role: "owner", lastViewedSec: 1700000000, createdSec: 1690000000 },
    ]);
    expect(R.decodeNotebookList([N], "wXbhsf")).toEqual([]);
    expect(() => R.decodeNotebookList([[["t"]]], "wXbhsf")).toThrow(RpcDriftError);
  });
  it("create notebook", () => {
    expect(R.decodeCreateNotebook(["T", N, U1], "CCqFvf")).toEqual({ id: U1 });
    expect(() => R.decodeCreateNotebook(["T"], "CCqFvf")).toThrow(RpcDriftError);
  });
  it("get notebook + sources, statuses, drive id envelope", () => {
    const row = [...nbRow];
    row[1] = [srcRow(2), [[N, true, [U1]], "Drive", [N, N, N, N, 14], [N, 5]], srcRow(1), srcRow(3)];
    const d = R.decodeGetNotebook([row], "rLM1Ne");
    expect(d.sources.map((s) => [s.id, s.status, s.type])).toEqual([
      [U2, "ready", "web_page"],
      [U1, "preparing", "drive"],
      [U2, "processing", "web_page"],
      [U2, "error", "web_page"],
    ]);
    expect(d.sources[0]).toMatchObject({ url: "https://x.y", wordCount: 120, createdSec: 1690000000, typeCode: 5 });
    expect(R.decodeGetNotebook([nbRow], "rLM1Ne").sources).toEqual([]);
    expect(() => R.decodeSourceRow([["nouuid"]], "rLM1Ne")).toThrow(RpcDriftError);
  });
  it("add source", () => {
    expect(R.decodeAddSource([[[[U2], "T"]]], "izAoDd")).toEqual({ id: U2, title: "T" });
    expect(() => R.decodeAddSource([[]], "izAoDd")).toThrow(RpcDriftError);
  });
  it("summary, guide, text, conversation id", () => {
    expect(R.decodeNotebookSummary([[["Sum"], [[["Q1", "P1"]]]]], "VfAZjd")).toEqual({
      summary: "Sum",
      suggestedQuestions: [{ question: "Q1", prompt: "P1" }],
    });
    expect(R.decodeNotebookSummary(N, "VfAZjd")).toBeNull();
    expect(R.decodeSourceGuide([[[N, ["Guide"], [["k1", "k2"]]]]], "tr032e")).toEqual({ summary: "Guide", keywords: ["k1", "k2"] });
    expect(() => R.decodeSourceGuide([[[N]]], "tr032e")).toThrow(RpcDriftError);
    expect(R.decodeSourceText([[N, "Title"], N, N, [[[0, 11, [[[0, 6, ["Hello ", [N, N, N, ""]]], [6, 11, ["world"]]], [N, 1]]]]]], "hizoJc")).toEqual({ title: "Title", text: "Hello world" });
    expect(() => R.decodeSourceText([[N, "T"]], "hizoJc")).toThrow(RpcDriftError);
    expect(R.decodeLastConversationId([[["conv1"]]], "hPTbtc")).toBe("conv1");
  });
  it("artifacts readiness", () => {
    const audio = (status: number, media: unknown) => ["a1", "Audio", 1, N, status, N, [N, N, N, N, N, media]];
    const video = (status: number, media: unknown) => ["v1", "Video", 3, N, status, N, N, N, [N, N, N, N, media]];
    const st = (r: unknown) => R.decodeArtifactRow(r, "gArtLc").state;
    expect(st(audio(1, N))).toBe("pending");
    expect(st(audio(2, N))).toBe("pending");
    expect(st(audio(3, N))).toBe("pending");
    expect(st(audio(4, N))).toBe("failed");
    const ok = R.decodeArtifactRow(audio(3, [["https://u/x-dv", 1, "audio/mp4"]]), "gArtLc");
    expect(ok).toMatchObject({ state: "ready", mediaUrl: "https://u/x-dv", mediaMime: "audio/mp4" });
    expect(st(video(3, [["https://u/h", 2, "application/x-mpegurl"]]))).toBe("pending");
    expect(R.decodeArtifactRow(video(3, [["https://u/h", 2, "x"], ["https://u/d", 4, "video/mp4"]]), "gArtLc").mediaUrl).toBe("https://u/d");
    expect(R.decodeArtifactList([[audio(2, N), video(4, N)]], "gArtLc").map((a) => a.id)).toEqual(["a1", "v1"]);
    expect(R.decodeArtifactList([audio(2, N)], "gArtLc").map((a) => a.id)).toEqual(["a1"]);
    expect(R.decodeArtifactList(N, "gArtLc")).toEqual([]);
    expect(R.decodeCreateArtifact([["a1", "T", 1, N, 1]], "R7cb6c")).toEqual({ id: "a1", statusCode: 1 });
    expect(() => R.decodeArtifactRow([N], "gArtLc")).toThrow(RpcDriftError);
  });
});

const chatWire = (...frames: unknown[]) => ")]}'\n" + frames.map((f) => `10\n${JSON.stringify([f])}\n`).join("");
const chunk = (text: string, final: boolean, cites: unknown[] = [], marker = 1) => [
  "wrb.fr",
  N,
  JSON.stringify([[text, N, ["stream", "turn"], N, [N, N, N, cites, marker]], N, N, N, final, [["Next?"]]]),
];
const cite = (src: string, frag: string) => [["chunk-" + frag], [N, N, 0.9, [[N, 10, 20]], [[[0, 1, [[[0, 1, [frag, []]]], [N, 1]]]]], [[[src]]]]];

describe("chat", () => {
  it("picks final cumulative chunk and maps citations", () => {
    const t = chatWire(
      chunk("thinking", false, [], 0),
      chunk("A [1]", false),
      chunk("A [1] and B [2, 1].", true, [cite(U1, "x"), cite(U2, "y")]),
      ["e", 4, N, N, 100],
    );
    const a = parseChatResponse(t);
    expect(a.text).toBe("A [1] and B [2, 1].");
    expect(a.isFinal).toBe(true);
    expect(a.markers).toEqual([1, 2]);
    expect(a.citations).toEqual([
      { index: 1, chunkId: "chunk-x", sourceId: U1, score: 0.9, range: { start: 10, end: 20 }, text: "x" },
      { index: 2, chunkId: "chunk-y", sourceId: U2, score: 0.9, range: { start: 10, end: 20 }, text: "y" },
    ]);
    expect(a.suggestedQuestions).toEqual(["Next?"]);
  });
  it("falls back to longest when no final", () => {
    expect(parseChatResponse(chatWire(chunk("short", false), chunk("much longer", false), chunk("mid", false))).text).toBe("much longer");
  });
  it("quota-exhausted shape and errors", () => {
    expect(() => parseChatResponse(chatWire(["di", 3], ["e", 4, N, N, 50]))).toThrow(RpcQuotaError);
    expect(() => parseChatResponse(chatWire(["wrb.fr", N, N, N, N, [3]]))).toThrow(RpcStatusError);
    expect(() => parseChatResponse(chatWire(["wrb.fr", N, N, N, N, [16]]))).toThrow(RpcAuthError);
    expect(() => parseChatResponse("<html></html>")).toThrow(RpcNoFramesError);
  });
});

describe("empty lists are not drift (T3-1)", () => {
  it.each([[[]], [null], [[null]], [[[]]]])("notebooks / artifacts / conversation id for %j", (shape) => {
    expect(R.decodeNotebookList(shape, "wXbhsf")).toEqual([]);
    expect(R.decodeArtifactList(shape, "gArtLc")).toEqual([]);
    expect(R.decodeLastConversationId(shape, "hPTbtc")).toBeNull();
  });
  it("genuine shape drift still raises", () => {
    expect(() => R.decodeNotebookList("oops", "wXbhsf")).toThrow(RpcDriftError);
    expect(() => R.decodeNotebookList([["not-a-row"]], "wXbhsf")).toThrow(RpcDriftError);
    expect(() => R.decodeArtifactList({ a: 1 }, "gArtLc")).toThrow(RpcDriftError);
    expect(() => R.decodeArtifactList([5], "gArtLc")).toThrow(RpcDriftError);
    expect(() => R.decodeLastConversationId("oops", "hPTbtc")).toThrow(RpcDriftError);
  });
});
