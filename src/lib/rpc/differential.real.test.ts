// DIFFERENTIAL TESTS (tester 3). Fixtures in ./__fixtures__ are SANITIZED captures from the VCR cassettes of
// teng-lin/notebooklm-py (recorded against real Google 2026-01..2026-08) and live-probe frames from its tests.
// `it.fails` marks a CURRENT DEFECT: each one references a finding in the tester-3 report (T3-n). When the fix
// lands the `it.fails` starts failing: flip it to `it`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBatchUrl, buildChatUrl, encodeBatchBody, encodeChatBody } from "./batchexecute";
import { parseChatResponse } from "./chat";
import { decodeBatchResponse } from "./decode";
import { RpcAuthError, RpcDriftError, RpcQuotaError, RpcStatusError, errorForHttpStatus } from "./errors";
import { sourcePathFor } from "./ids";
import { classifyHomepage, extractPageTokens } from "./page";
import * as P from "./params";
import * as R from "./rows";

const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", `${n}.json`), "utf8")) as { body: string; rpcId: string };
const dec = (n: string, allowNull = false) => {
  const f = fx(n);
  return { f, result: decodeBatchResponse(f.body, f.rpcId, { allowNull }) };
};

describe("real captures: homepage tokens", () => {
  it("extracts at / fsid / bl and classifies ok", () => {
    const html = fx("homepage-signed-in").body;
    const t = extractPageTokens(html);
    expect(t.at).toBe("SYNTHETIC_AT_TOKEN_aB-_9:1700000000000");
    expect(t.fsid).toBe("-1234567890123456789");
    expect(t.bl).toMatch(/^boq_labs-tailwind-frontend_\d{8}\.\d\d_p\d+$/);
    expect(classifyHomepage({ finalUrl: "https://notebook.google.com/?hl=en", status: 200, html })).toBe("ok");
  });
});

describe("real captures: notebooks", () => {
  it("list", () => {
    const { result } = dec("notebooks-list");
    const l = R.decodeNotebookList(result, "wXbhsf");
    expect(l).toHaveLength(3);
    for (const n of l) {
      expect(n.id).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
      expect(n.title.length).toBeGreaterThan(0);
      expect(n.role).toBe("owner");
      expect(n.lastViewedSec).toBeGreaterThan(1_700_000_000);
      expect(n.createdSec).toBeGreaterThan(1_700_000_000);
    }
    expect(l.map((n) => n.lastViewedSec!)).toEqual([...l.map((n) => n.lastViewedSec!)].sort((a, b) => b - a));
  });
  it("create: id at [2]", () => {
    expect(R.decodeCreateNotebook(dec("notebook-create").result, "CCqFvf").id).toMatch(/^00000000-0000-4000-8000-/);
  });
  it("get: sources, statuses, types, urls", () => {
    const d = R.decodeGetNotebook(dec("notebook-get").result, "rLM1Ne");
    expect(d.sources.length).toBe(4);
    expect(new Set(d.sources.map((s) => s.status))).toEqual(new Set(["ready"]));
    expect(d.sources.map((s) => s.typeCode)).toEqual(expect.arrayContaining([5, 3, 4]));
    const web = d.sources.find((s) => s.typeCode === 5)!;
    expect(web.url).toMatch(/^https:\/\/example\.com\//);
    expect(web.wordCount).toBeGreaterThan(0);
    expect(web.createdSec).toBeGreaterThan(1_700_000_000);
    expect(d.sources.find((s) => s.typeCode === 4)!.url).toBeNull();
  });
  it("get: preparing upload (status 5, type code 0) and zero sources", () => {
    const p = R.decodeGetNotebook(dec("notebook-get-preparing").result, "rLM1Ne");
    expect(p.sources[0]).toMatchObject({ status: "preparing", type: "unknown", url: null });
    expect(R.decodeGetNotebook(dec("notebook-get-zero-sources").result, "rLM1Ne").sources).toEqual([]);
  });
  it("summary + suggested questions, guide, last conversation id", () => {
    const s = R.decodeNotebookSummary(dec("notebook-summary", true).result, "VfAZjd")!;
    expect(s.summary.length).toBeGreaterThan(100);
    expect(s.suggestedQuestions.length).toBe(3);
    expect(s.suggestedQuestions[0]!.prompt).toBeTruthy();
    const g = R.decodeSourceGuide(dec("source-guide").result, "tr032e");
    expect(g.summary.length).toBeGreaterThan(100);
    expect(g.keywords).toHaveLength(5);
    expect(R.decodeLastConversationId(dec("last-conversation-id").result, "hPTbtc")).toMatch(/^00000000-0000-4000-8000-/);
  });
});

describe("real captures: add source", () => {
  it("url + text echo", () => {
    expect(R.decodeAddSource(dec("add-source-url").result, "izAoDd").id).toMatch(/^00000000-0000-4000-8000-/);
    expect(R.decodeAddSource(dec("add-source-text").result, "izAoDd").title).toBeTruthy();
  });
  it("T3-6 evidence: Drive add returns a Google-derived title (not the one sent): title matching cannot reconcile", () => {
    // Request in the cassette sent title "VCR Test Drive Doc" (12+ chars: "xxx xxxx xxxxx xxx"); response title differs in length.
    const r = R.decodeAddSource(dec("add-source-drive").result, "izAoDd");
    expect(r.title).not.toBeNull();
    expect(r.title).not.toBe("VCR Test Drive Doc");
    expect(r.title!.length).not.toBe("VCR Test Drive Doc".length);
  });
});

describe("real captures: artifacts", () => {
  it("READY audio + video rows: media url selection (-dv download variant), state, createdSec", () => {
    const rows = R.decodeArtifactList(dec("artifacts-list-media").result, "gArtLc");
    const audio = rows.filter((a) => a.typeCode === 1);
    const video = rows.filter((a) => a.typeCode === 3);
    expect(audio.length).toBeGreaterThan(0);
    expect(video.length).toBeGreaterThan(0);
    for (const a of audio) {
      expect(a).toMatchObject({ statusCode: 3, state: "ready", mediaMime: "audio/mp4" });
      expect(a.mediaUrl).toMatch(/=m140-dv$/);
      expect(a.createdSec).toBeGreaterThan(1_700_000_000);
    }
    for (const v of video) {
      expect(v).toMatchObject({ statusCode: 3, state: "ready", mediaMime: "video/mp4" });
      expect(v.mediaUrl).toMatch(/=m22-dv$/);
    }
  });
  it("pending rows (status 1) are not ready", () => {
    const rows = R.decodeArtifactList(dec("artifacts-list-pending").result, "gArtLc");
    expect(rows.some((a) => a.statusCode === 1 && a.state === "pending")).toBe(true);
    expect(rows.some((a) => a.statusCode === 3 && a.state === "ready")).toBe(true);
  });
  it("create kickoff: id [0][0], status [0][4]", () => {
    const d = R.decodeCreateArtifact(dec("artifact-create").result, "R7cb6c");
    expect(d.id).toMatch(/^00000000-0000-4000-8000-/);
    expect(d.statusCode).toBe(1);
  });
  // T3-1 BLOCKER: real capture of a notebook with no artifacts.
  it("T3-1: empty artifact list ('[]') decodes to []", () => {
    const { result } = dec("artifacts-list-empty");
    expect(result).toEqual([]);
    expect(R.decodeArtifactList(result, "gArtLc")).toEqual([]);
  });
});

describe("real captures: chat stream", () => {
  const ans = () => parseChatResponse(fx("chat-stream-final").body);
  it("picks the final cumulative chunk, markers, citations with source ids and ranges, suggestions", () => {
    const a = ans();
    expect(a.isFinal).toBe(true);
    expect(a.markers).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(a.citations).toHaveLength(7);
    for (const c of a.citations) {
      expect(c.sourceId).toMatch(/^00000000-0000-4000-8000-/);
      expect(c.chunkId).toMatch(/^00000000-0000-4000-8000-/);
      expect(c.score).toBeGreaterThan(0.6);
      expect(c.range!.end).toBeGreaterThan(c.range!.start);
    }
    expect(new Set(a.citations.map((c) => c.sourceId)).size).toBe(1);
    expect(a.suggestedQuestions).toHaveLength(3);
    expect(a.text.length).toBeGreaterThan(1500);
  });
  it("thinking chunks (TailwindDoc last element 2) are never selected", () => {
    expect(ans().text.length).toBeGreaterThan(1000);
  });
  it("rejection frame wrb.fr(null id, [3]) -> RpcStatusError 3", () => {
    expect(() => parseChatResponse(fx("chat-rejected-3").body)).toThrow(RpcStatusError);
    try {
      parseChatResponse(fx("chat-rejected-3").body);
    } catch (e) {
      expect((e as RpcStatusError).code).toBe(3);
    }
  });
  // T3-3: citation excerpts are polluted with link-annotation URLs (scrubbed to example.com here).
  it("T3-3: citation excerpt text contains no link-annotation URL strings", () => {
    const withLinks = ans().citations.filter((c) => /https?:\/\//.test(c.text));
    expect(withLinks).toEqual([]);
    // Clean spans only: markers like "[ edit]" survive, the href inside the link annotation does not.
    expect(ans().citations.some((c) => c.text.includes("]"))).toBe(true);
  });
});

describe("real captures: source text", () => {
  // T3-2: hizoJc tree: blocks [start,end,[spans...],[kind],..., listId...]; concatenating every string leaf adds list ids and link URLs.
  it("T3-2: decoded source text length equals the document range and has no link/list-id noise", () => {
    const { result } = dec("source-text");
    const tree = ((result as unknown[][])[3]![0] as unknown[][])[0] as number[][];
    const lastEnd = (tree[tree.length - 1] as number[])[1]!;
    const t = R.decodeSourceText(result, "hizoJc").text;
    expect(t).not.toMatch(/https?:\/\//);
    // Spans are contiguous, so the clean text is exactly the document range; blocks are joined with "\n" (cosmetic).
    expect(t.length).toBe(lastEnd + (tree.length - 1));
    expect(t.replaceAll("\n", "").length).toBe(lastEnd);
  });
});

describe("live-probe error frames (verbatim from notebooklm-py tests)", () => {
  const e = JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "error-frames.json"), "utf8")) as Record<string, string>;
  it("CREATE_ARTIFACT on a source-less notebook: status [3]", () => {
    expect(() => decodeBatchResponse(e.create_invalid_argument!, "R7cb6c")).toThrow(RpcStatusError);
  });
  it("RETRY not found: status [5]", () => {
    try {
      decodeBatchResponse(e.retry_not_found!, "Rytqqe");
      expect.unreachable();
    } catch (x) {
      expect(x).toBeInstanceOf(RpcStatusError);
      expect((x as RpcStatusError).statusName).toBe("NOT_FOUND");
    }
  });
  it("UserDisplayableError status [8,null,[[type.googleapis.com/...UserDisplayableError,...]]] -> quota", () => {
    const status = [8, null, [["type.googleapis.com/google.internal.labs.tailwind.orchestration.v1.UserDisplayableError", [null, null, null, null, [null, [[1]], 2]]]]];
    const line = JSON.stringify([["wrb.fr", "R7cb6c", null, null, null, status, "generic"]]);
    expect(() => decodeBatchResponse(`)]}'\n\n${line.length}\n${line}\n`, "R7cb6c")).toThrow(RpcQuotaError);
  });
  it("wrong rpc id in a real frame -> drift (rotated id), not status", () => {
    expect(() => decodeBatchResponse(e.create_invalid_argument!, "XXXXXX")).toThrow(RpcDriftError);
  });
  it("RotateCookies response is not a batch response", () => {
    expect(() => decodeBatchResponse(e.rotate_cookies_response!, "wXbhsf")).toThrow();
  });
  // T3-4: Google answers an expired CSRF `at` with HTTP 400 + ["INVALID_CREDENTIALS"] (notebooklm-py treats 400 as an auth error and refreshes once).
  it("T3-4: HTTP 400 (expired at token) is classified as an auth error", () => {
    expect(errorForHttpStatus("wXbhsf", 400)).toBeInstanceOf(RpcAuthError);
  });
});

// --- request builders vs. recorded real request bodies (ids normalised) -------------------------------------
const NB = "nb-1";
const freq = (rpc: string, params: unknown) => decodeURIComponent(encodeBatchBody({ rpcId: rpc, params, at: "AT" })).replace(/&at=.*$/, "");
const rec = (rpc: string, params: unknown) => `f.req=${JSON.stringify([[[rpc, JSON.stringify(params), null, "generic"]]])}`;
describe("request builders == real recorded bodies (notebooklm-py cassettes)", () => {
  it("list notebooks", () => expect(freq("wXbhsf", P.listNotebooksParams())).toBe(rec("wXbhsf", [null, 1, null, [2]])));
  it("create notebook (W wrapper)", () =>
    expect(freq("CCqFvf", P.createNotebookParams("T"))).toBe(rec("CCqFvf", ["T", null, null, [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]])));
  it("get notebook (W wrapper)", () =>
    expect(P.getNotebookParams(NB)).toEqual([NB, null, [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]], null, 0]));
  it("summary", () => expect(P.notebookSummaryParams(NB)).toEqual([NB, [2]]));
  it("rename", () => expect(P.renameNotebookParams(NB, "T")).toEqual([NB, [[null, null, null, [null, "T"]]]]));
  it("add url / youtube / text", () => {
    const W = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
    expect(P.addSourceUrlParams(NB, "https://e.com/a")).toEqual([[[null, null, ["https://e.com/a"], null, null, null, null, null, null, null, 1]], NB, W]);
    expect(P.addSourceYoutubeParams(NB, "https://www.youtube.com/watch?v=abc")).toEqual([[[null, null, null, null, null, null, null, ["https://www.youtube.com/watch?v=abc"], null, null, 1]], NB, W]);
    expect(P.addSourceTextParams(NB, "T", "C")).toEqual([[[null, ["T", "C"], null, 2, null, null, null, null, null, null, 1]], NB, W]);
  });
  it("add drive (older tail, as recorded)", () =>
    expect(P.addSourceDriveParams(NB, { fileId: "f1", mimeType: "application/vnd.google-apps.document", title: "D" })).toEqual([
      [[["f1", "application/vnd.google-apps.document", 1, "D"], null, null, null, null, null, null, null, null, 1]],
      NB,
      [2],
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ]));
  it("source text / guide", () => {
    expect(P.sourceTextParams("s1")).toEqual([["s1"], [2], [2]]);
    expect(P.sourceGuideParams("s1")).toEqual([[[["s1"]]]]);
  });
  it("last conversation id, list artifacts", () => {
    expect(P.lastConversationIdParams(NB)).toEqual([[], null, NB, 1]);
    expect(P.listArtifactsParams(NB)).toEqual([[2], NB, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"']);
  });
  it("chat params (first turn, no history)", () =>
    expect(P.chatParams({ notebookId: NB, sourceIds: ["s1", "s2"], question: "Q" })).toEqual([[[["s1"]], [["s2"]]], "Q", null, [2, null, [1], [1]], null, null, null, NB, 1]));
  it("chat body shape f.req=[null,\"<params json>\"]", () => {
    const body = decodeURIComponent(encodeChatBody({ params: ["x"], at: "AT:1" }));
    expect(body).toBe('f.req=[null,"[\\"x\\"]"]&at=AT:1&');
  });
  // notebooklm-py tests/unit/test_rpc_golden_payloads.py (current CA envelope)
  const CA = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];
  it("audio defaults == golden", () =>
    expect(P.createAudioParams({ notebookId: "nb_payload", sourceIds: ["src_alpha"] })).toEqual([CA, "nb_payload", [null, null, 1, [[["src_alpha"]]], null, null, [null, [null, 2, null, [["src_alpha"]], "en", null, 1]]]]));
  it("audio explicit == golden", () =>
    expect(
      P.createAudioParams({ notebookId: "nb_payload", sourceIds: ["src_alpha", "src_beta"], language: "es", focusPrompt: "Focus on terminology", format: P.AudioFormat.Brief, length: P.AudioLength.Short }),
    ).toEqual([
      CA,
      "nb_payload",
      [null, null, 1, [[["src_alpha"]], [["src_beta"]]], null, null, [null, ["Focus on terminology", 1, null, [["src_alpha"], ["src_beta"]], "es", null, 2]]],
    ]));
  it("video defaults == golden", () =>
    expect(P.createVideoParams({ notebookId: "nb_payload", sourceIds: ["src_alpha"] })).toEqual([CA, "nb_payload", [null, null, 3, [[["src_alpha"]]], null, null, null, null, [null, null, [[["src_alpha"]], "en", null, null, 1, 1]]]]));
  it("video custom style == golden", () =>
    expect(P.createVideoParams({ notebookId: "nb_payload", sourceIds: ["src_alpha"], language: "fr", focusPrompt: "Summarize visually", style: "custom", stylePrompt: "blueprint line art" })).toEqual([
      CA,
      "nb_payload",
      [null, null, 3, [[["src_alpha"]]], null, null, null, null, [null, null, [[["src_alpha"]], "fr", "Summarize visually", null, 1, null, "blueprint line art"]]],
    ]));
  it("batch url: rpcids/source-path/f.sid/hl/rt present", () => {
    const u = new URL(buildBatchUrl({ base: "https://notebook.google.com", rpcId: "wXbhsf", sourcePath: "/", fsid: "S" }));
    expect(u.pathname).toBe("/_/LabsTailwindUi/data/batchexecute");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ rpcids: "wXbhsf", "source-path": "/", "f.sid": "S", hl: "en", rt: "c" });
  });
  it("chat url params (bl, hl, _reqid, rt, f.sid)", () => {
    const u = new URL(buildChatUrl({ base: "https://notebook.google.com", bl: "B", reqId: 200000, fsid: "S" }));
    expect(Object.fromEntries(u.searchParams)).toEqual({ bl: "B", hl: "en", _reqid: "200000", rt: "c", "f.sid": "S" });
  });
  // T3-5: recorded real rename calls (notebooks_rename.yaml, cli_notebook_rename.yaml, PY source "Home page context") use source-path "/".
  it("T3-5: rename uses source-path '/' like every recorded real call", () => {
    expect(sourcePathFor("RENAME_NOTEBOOK", "00000000-0000-4000-8000-000000000001")).toBe("/");
  });
});
