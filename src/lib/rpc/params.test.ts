// SYNTHETIC fixture built from docs/PROTOCOL.md; replace with real capture in the real-data run
import { describe, expect, it } from "vitest";
import * as P from "./params";

const N = null;
const Wx = [2, N, N, [1, N, N, N, N, N, N, N, N, N, [1]]];
const CAx = [2, N, N, [1, N, N, N, N, N, N, N, N, N, [1]], [[1, 4, 8, 2, 3, 6]]];
const nb = "nb-1";

describe("params builders (PROTOCOL §3)", () => {
  it("wrappers", () => {
    expect(P.W()).toEqual(Wx);
    expect(P.CA()).toEqual(CAx);
  });
  it("notebooks", () => {
    expect(P.listNotebooksParams()).toEqual([N, 1, N, [2]]);
    expect(P.createNotebookParams("T")).toEqual(["T", N, N, Wx]);
    expect(P.renameNotebookParams(nb, "New")).toEqual([nb, [[N, N, N, [N, "New"]]]]);
    expect(P.getNotebookParams(nb)).toEqual([nb, N, Wx, N, 0]);
    expect(P.notebookSummaryParams(nb)).toEqual([nb, [2]]);
    expect(() => P.createNotebookParams("")).toThrow();
  });
  it("sources", () => {
    expect(P.addSourceUrlParams(nb, "https://a.b/c")).toEqual([[[N, N, ["https://a.b/c"], N, N, N, N, N, N, N, 1]], nb, Wx]);
    expect(P.addSourceUrlFallbackParams("https://a.b")).toEqual([[[[N, "https://a.b", 627], [N, N, N, N, N, N, N, N, N, [N, N, 1]], 1]]]);
    expect(P.addSourceYoutubeParams(nb, "https://youtu.be/x")).toEqual([[[N, N, N, N, N, N, N, ["https://youtu.be/x"], N, N, 1]], nb, Wx]);
    expect(() => P.addSourceYoutubeParams(nb, "https://a.b/x")).toThrow();
    expect(() => P.addSourceUrlParams(nb, "javascript:alert(1)")).toThrow();
    expect(P.addSourceTextParams(nb, "t", "body")).toEqual([[[N, ["t", "body"], N, 2, N, N, N, N, N, N, 1]], nb, Wx]);
    expect(P.addSourceDriveParams(nb, { fileId: "F1", mimeType: "application/pdf", title: "d" })).toEqual([
      [[["F1", "application/pdf", 1, "d"], N, N, N, N, N, N, N, N, 1]],
      nb,
      [2],
      [1, N, N, N, N, N, N, N, N, N, [1]],
    ]);
    expect(P.sourceTextParams("s1")).toEqual([["s1"], [2], [2]]);
    expect(P.sourceGuideParams("s1")).toEqual([[[["s1"]]]]);
  });
  it("chat", () => {
    expect(P.lastConversationIdParams(nb)).toEqual([[], N, nb, 1]);
    expect(P.chatParams({ notebookId: nb, sourceIds: ["s1", "s2"], question: "q?" })).toEqual([
      [[["s1"]], [["s2"]]], "q?", N, [2, N, [1], [1]], N, N, N, nb, 1,
    ]);
    expect(
      P.chatParams({ notebookId: nb, sourceIds: ["s1"], question: "q2", history: [{ question: "q1", answer: "a1" }], conversationId: "c1" })[2],
    ).toEqual([["a1", N, 2], ["q1", N, 1]]);
  });
  it("artifacts list", () => {
    expect(P.listArtifactsParams(nb)).toEqual([[2], nb, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"']);
  });
  it("audio", () => {
    expect(
      P.createAudioParams({ notebookId: nb, sourceIds: ["s1"], format: P.AudioFormat.Debate, length: P.AudioLength.Long, language: "it", focusPrompt: "focus" }),
    ).toEqual([CAx, nb, [N, N, 1, [[["s1"]]], N, N, [N, ["focus", 3, N, [["s1"]], "it", N, 4]]]]);
    expect(P.createAudioParams({ notebookId: nb, sourceIds: ["s1"] })[2]).toEqual([N, N, 1, [[["s1"]]], N, N, [N, [N, 2, N, [["s1"]], "en", N, 1]]]);
    expect(() => P.createAudioParams({ notebookId: nb, sourceIds: [] })).toThrow();
  });
  it("video", () => {
    expect(P.createVideoParams({ notebookId: nb, sourceIds: ["s1"], format: P.VideoFormat.Brief, style: "kawaii" })).toEqual([
      CAx, nb, [N, N, 3, [[["s1"]]], N, N, N, N, [N, N, [[["s1"]], "en", N, N, 2, 9]]],
    ]);
    expect(P.createVideoParams({ notebookId: nb, sourceIds: ["s1"], style: "custom", stylePrompt: "neon" })[2]).toEqual([
      N, N, 3, [[["s1"]]], N, N, N, N, [N, N, [[["s1"]], "en", N, N, 1, N, "neon"]],
    ]);
    expect(P.createVideoParams({ notebookId: nb, sourceIds: ["s1"] })[0]).toEqual(CAx);
    expect(() => P.createVideoParams({ notebookId: nb, sourceIds: ["s1"], style: "custom" })).toThrow();
    expect(() => P.createVideoParams({ notebookId: nb, sourceIds: ["s1"], format: 3 as P.VideoFormat })).toThrow();
  });
});
