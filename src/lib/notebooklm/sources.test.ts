// Fixtures are SYNTHETIC (built from docs/PROTOCOL.md §3.2); replace with real captures in the real-data run.
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { RpcCall } from "@/lib/google/client";
import { AmbiguousMutationError, NetworkError, StaleTokenMutationError } from "@/lib/google/errors";
import {
  addSourceDriveParams,
  addSourceTextParams,
  addSourceUrlFallbackParams,
  addSourceUrlParams,
  addSourceYoutubeParams,
  sourceGuideParams,
  sourceTextParams,
} from "@/lib/rpc/params";
import { RpcAuthError, RpcStatusError } from "@/lib/rpc/errors";
import { MemoryCreatedObjects } from "./created";
import { createNotebookOps } from "./notebooks";
import {
  SOURCE_TEXT_CAP,
  SourceAddAmbiguousError,
  SourceAddUnconfirmedError,
  SourceNotFoundError,
  SourceNotReadyError,
  createSourceOps,
  sameUrl,
  type UrlRpcCache,
} from "./sources";

const N = null;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ACC = "acc-1";
const NB = uuid(1);
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);

interface SrcSpec {
  url?: string;
  yt?: string;
  status?: number;
  type?: number;
  created?: number | null;
}
const srcRow = (i: number, title: string, o: SrcSpec = {}) => [
  [uuid(i)],
  title,
  [N, 120, o.created === null ? N : [o.created ?? NOW_SEC - 86400 * 30], N, o.type ?? 5, o.yt ? [o.yt] : N, N, o.url ? [o.url] : N],
  [N, o.status ?? 2],
];
const notebookResult = (rows: unknown[]) => [["NB", rows, NB, "📘", N, [1, N, N, N, N, [NOW_SEC], N, N, [NOW_SEC]]]];
const addResult = (i: number, title: string) => [[[[uuid(i)], title]]];

type Responder = (c: RpcCall) => unknown;
function stub(responders: Responder[]) {
  const calls: RpcCall[] = [];
  const q = [...responders];
  return {
    calls,
    client: {
      async rpc(c: RpcCall) {
        calls.push(c);
        const r = q.shift();
        if (!r) throw new Error(`unexpected rpc ${c.name}`);
        return r(c);
      },
    },
    remaining: () => q.length,
  };
}
const boom = (e: unknown): Responder => () => {
  throw e;
};
const invalidArg = () => new AmbiguousMutationError("izAoDd", "gRPC 3 INVALID_ARGUMENT");

function setup(responders: Responder[], cache: UrlRpcCache = { winner: null }) {
  const s = stub(responders);
  const created = new MemoryCreatedObjects();
  const notebooks = createNotebookOps({ client: s.client, created });
  const ops = createSourceOps({ client: s.client, created, notebooks, now: () => NOW, urlRpcCache: cache });
  return { ...s, created, ops, cache };
}
const names = (calls: RpcCall[]) => calls.map((c) => c.name);

describe("sameUrl", () => {
  it("ignores case of host, hash and trailing slash; matches YouTube by video id", () => {
    expect(sameUrl("https://Example.com/a/", "https://example.com/a#x")).toBe(true);
    expect(sameUrl("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameUrl("https://youtu.be/abcDEF12345", "https://www.youtube.com/watch?v=abcDEF12345&t=3")).toBe(true);
    expect(sameUrl("https://youtu.be/aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb")).toBe(false);
  });
});

describe("addSourceUrl", () => {
  const URL_ = "https://example.com/article";

  it("success: one mutation (izAoDd) + one status read, records the id in created_objects, never waits", async () => {
    const t = setup([() => addResult(10, "Article"), () => notebookResult([srcRow(10, "Article title", { url: URL_, status: 1 })])]);
    const r = await t.ops.addSourceUrl(ACC, NB, URL_);
    expect(r).toEqual({ sourceId: uuid(10), title: "Article title", status: "processing", reconciled: false });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
    expect(t.calls[0]).toMatchObject({ accountId: ACC, notebookId: NB, kind: "mutate", tool: "source_add_url", params: addSourceUrlParams(NB, URL_) });
    expect(t.calls[1]).toMatchObject({ kind: "read" });
    expect(await t.created.has(ACC, "source", uuid(10))).toBe(true);
    expect(t.cache.winner).toBe("primary");
  });

  it("maps every status code: ready, error, preparing, unknown -> processing", async () => {
    for (const [code, want] of [[2, "ready"], [3, "error"], [5, "preparing"], [-1, "processing"]] as const) {
      const t = setup([() => addResult(10, "A"), () => notebookResult([srcRow(10, "A", { status: code })])]);
      expect((await t.ops.addSourceUrl(ACC, NB, URL_)).status).toBe(want);
    }
  });

  it("a failed status read after a successful add still reports the add (processing), without a second add", async () => {
    const t = setup([() => addResult(10, "Added"), boom(new NetworkError("rLM1Ne", "timeout"))]);
    expect(await t.ops.addSourceUrl(ACC, NB, URL_)).toEqual({ sourceId: uuid(10), title: "Added", status: "processing", reconciled: false });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
  });

  it("a created_objects failure does not turn a successful add into an error", async () => {
    const s = stub([() => addResult(10, "A"), () => notebookResult([srcRow(10, "A")])]);
    const created = {
      record: async () => {
        throw new Error("db down");
      },
      has: async () => false,
      list: async () => [],
    };
    const notebooks = createNotebookOps({ client: s.client, created });
    const ops = createSourceOps({ client: s.client, created, notebooks, urlRpcCache: { winner: null } });
    expect((await ops.addSourceUrl(ACC, NB, URL_)).sourceId).toBe(uuid(10));
  });

  it("validation failures never reach the network", async () => {
    const t = setup([]);
    const bad = ["", "   ", "ftp://example.com/x", "javascript:alert(1)", "file:///etc/passwd", "no scheme", "https://user:secret@example.com/", "https://example.com/" + "a".repeat(2048)];
    for (const u of bad) await expect(t.ops.addSourceUrl(ACC, NB, u)).rejects.toBeInstanceOf(ZodError);
    await expect(t.ops.addSourceUrl(ACC, "not-a-uuid", URL_)).rejects.toBeInstanceOf(ZodError);
    expect(t.calls).toHaveLength(0);
    // exactly 2048 chars is allowed
    const t2 = setup([() => addResult(10, "A"), () => notebookResult([])]);
    await t2.ops.addSourceUrl(ACC, NB, "https://example.com/" + "a".repeat(2048 - 20));
    expect(t2.calls).toHaveLength(2);
  });

  it("falls back to ozz5Z only after an INVALID_ARGUMENT refusal with nothing added, and caches the winner", async () => {
    const cache: UrlRpcCache = { winner: null };
    const t = setup(
      [
        boom(invalidArg()),
        () => notebookResult([srcRow(2, "Other", { url: "https://example.com/other" })]), // reconcile: not there
        () => addResult(11, "Via fallback"),
        () => notebookResult([srcRow(11, "Via fallback", { url: URL_, status: 2 })]),
        // second add in the same process starts with the cached winner
        () => addResult(12, "Second"),
        () => notebookResult([srcRow(12, "Second", { status: 1 })]),
      ],
      cache,
    );
    const r = await t.ops.addSourceUrl(ACC, NB, URL_);
    expect(r).toMatchObject({ sourceId: uuid(11), status: "ready", reconciled: false });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK", "ADD_SOURCE_URL_FALLBACK", "GET_NOTEBOOK"]);
    expect(t.calls[2]).toMatchObject({ kind: "mutate", notebookId: NB, params: addSourceUrlFallbackParams(URL_) });
    expect(cache.winner).toBe("fallback");
    expect(await t.created.has(ACC, "source", uuid(11))).toBe(true);

    await t.ops.addSourceUrl(ACC, NB, "https://example.com/second");
    expect(t.calls[4]!.name).toBe("ADD_SOURCE_URL_FALLBACK");
    expect(t.remaining()).toBe(0);
  });

  it("also treats a plain RpcStatusError(3) as an INVALID_ARGUMENT refusal", async () => {
    const t = setup([boom(new RpcStatusError("izAoDd", 3)), () => notebookResult([]), () => addResult(11, "F"), () => notebookResult([srcRow(11, "F")])]);
    expect((await t.ops.addSourceUrl(ACC, NB, URL_)).sourceId).toBe(uuid(11));
    expect(names(t.calls)).toContain("ADD_SOURCE_URL_FALLBACK");
  });

  it("does NOT fall back on a timeout / network ambiguity, and reports unconfirmed when the list does not show it", async () => {
    const t = setup([boom(new AmbiguousMutationError("izAoDd", "timeout")), () => notebookResult([])]);
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBeInstanceOf(SourceAddUnconfirmedError);
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
    expect(await t.created.list(ACC, "source")).toEqual([]);
  });

  it("does NOT fall back on a stale-token ambiguity", async () => {
    const t = setup([boom(new StaleTokenMutationError("izAoDd")), () => notebookResult([])]);
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBeInstanceOf(SourceAddUnconfirmedError);
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
  });

  it("ambiguous failure + reconciliation: finds the new source by URL and created time, no second add", async () => {
    const t = setup([
      boom(new AmbiguousMutationError("izAoDd", "timeout")),
      () =>
        notebookResult([
          srcRow(2, "Same URL but old", { url: URL_, created: NOW_SEC - 86400 * 3 }), // pre-existing: too old
          srcRow(3, "Different", { url: "https://example.com/else", created: NOW_SEC - 2 }),
          srcRow(4, "Fresh", { url: URL_, created: NOW_SEC - 2, status: 1 }),
        ]),
    ]);
    const r = await t.ops.addSourceUrl(ACC, NB, URL_);
    expect(r).toEqual({ sourceId: uuid(4), title: "Fresh", status: "processing", reconciled: true });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]); // one add only; the reconcile read doubles as the status read
    expect(await t.created.list(ACC, "source")).toEqual([uuid(4)]);
  });

  it("INVALID_ARGUMENT but the source is actually there: reconciles instead of trying ozz5Z (no double add)", async () => {
    const cache: UrlRpcCache = { winner: null };
    const t = setup([boom(invalidArg()), () => notebookResult([srcRow(4, "Landed", { url: URL_, created: NOW_SEC - 1 })])], cache);
    const r = await t.ops.addSourceUrl(ACC, NB, URL_);
    expect(r).toMatchObject({ sourceId: uuid(4), reconciled: true });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
    expect(cache.winner).toBe("primary");
  });

  it("sources this app already recorded are never matched again", async () => {
    const t = setup([boom(new AmbiguousMutationError("izAoDd", "timeout")), () => notebookResult([srcRow(4, "Earlier add", { url: URL_, created: NOW_SEC - 5 })])]);
    await t.created.record(ACC, "source", uuid(4));
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBeInstanceOf(SourceAddUnconfirmedError);
  });

  it("two plausible matches: reports ambiguity and records nothing", async () => {
    const t = setup([
      boom(new AmbiguousMutationError("izAoDd", "timeout")),
      () => notebookResult([srcRow(4, "A", { url: URL_, created: NOW_SEC - 5 }), srcRow(5, "B", { url: URL_, created: NOW_SEC - 4 })]),
    ]);
    const e = await t.ops.addSourceUrl(ACC, NB, URL_).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SourceAddAmbiguousError);
    expect((e as SourceAddAmbiguousError).candidateIds).toEqual([uuid(4), uuid(5)]);
    expect(await t.created.list(ACC, "source")).toEqual([]);
  });

  it("both RPCs refused with INVALID_ARGUMENT and nothing appears: unconfirmed after exactly two attempts", async () => {
    const cache: UrlRpcCache = { winner: null };
    const t = setup([boom(invalidArg()), () => notebookResult([]), boom(new AmbiguousMutationError("ozz5Z", "gRPC 3 INVALID_ARGUMENT")), () => notebookResult([])], cache);
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBeInstanceOf(SourceAddUnconfirmedError);
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK", "ADD_SOURCE_URL_FALLBACK", "GET_NOTEBOOK"]);
    expect(cache.winner).toBeNull();
  });

  it("if the reconcile read itself fails, the original ambiguity is reported (never a second add)", async () => {
    const orig = new AmbiguousMutationError("izAoDd", "timeout");
    const t = setup([boom(orig), boom(new NetworkError("rLM1Ne", "timeout"))]);
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBe(orig);
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
  });

  it("an unreadable ozz5Z response (drift) is reconciled, not retried", async () => {
    const cache: UrlRpcCache = { winner: "fallback" };
    const t = setup([() => ["unexpected"], () => notebookResult([srcRow(4, "Landed", { url: URL_, created: NOW_SEC - 1 })])], cache);
    const r = await t.ops.addSourceUrl(ACC, NB, URL_);
    expect(r).toMatchObject({ sourceId: uuid(4), reconciled: true });
    expect(names(t.calls)).toEqual(["ADD_SOURCE_URL_FALLBACK", "GET_NOTEBOOK"]);
  });

  it("auth / non-ambiguous errors are rethrown untouched (no reconcile, no fallback)", async () => {
    const e = new RpcAuthError("izAoDd", "grpc_16");
    const t = setup([boom(e)]);
    await expect(t.ops.addSourceUrl(ACC, NB, URL_)).rejects.toBe(e);
    expect(t.calls).toHaveLength(1);
  });
});

describe("addSourceYoutube / addSourceText / addSourceDrive", () => {
  it("youtube: izAoDd with the YouTube spec, rejects other hosts, no fallback RPC", async () => {
    const yt = "https://www.youtube.com/watch?v=abcDEF12345";
    const t = setup([() => addResult(20, "Video"), () => notebookResult([srcRow(20, "Video", { yt, type: 9, status: 1 })])]);
    const r = await t.ops.addSourceYoutube(ACC, NB, yt);
    expect(r).toMatchObject({ sourceId: uuid(20), status: "processing" });
    expect(t.calls[0]).toMatchObject({ name: "ADD_SOURCE", kind: "mutate", tool: "source_add_youtube", params: addSourceYoutubeParams(NB, yt) });
    expect(await t.created.has(ACC, "source", uuid(20))).toBe(true);
    for (const bad of ["https://example.com/watch?v=abc", "https://notyoutube.com/x", "ftp://youtube.com/x", "https://u:p@youtube.com/x"]) {
      await expect(t.ops.addSourceYoutube(ACC, NB, bad)).rejects.toBeInstanceOf(ZodError);
    }
    expect(t.calls).toHaveLength(2);
  });

  it("youtube: INVALID_ARGUMENT is reconciled but never falls back to ozz5Z", async () => {
    const yt = "https://youtu.be/abcDEF12345";
    const t = setup([boom(invalidArg()), () => notebookResult([])]);
    await expect(t.ops.addSourceYoutube(ACC, NB, yt)).rejects.toBeInstanceOf(SourceAddUnconfirmedError);
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
  });

  it("youtube: reconciles when Google canonicalised the URL", async () => {
    const t = setup([
      boom(new AmbiguousMutationError("izAoDd", "timeout")),
      () => notebookResult([srcRow(21, "Canon", { yt: "https://www.youtube.com/watch?v=abcDEF12345", type: 9, created: NOW_SEC - 3 })]),
    ]);
    expect((await t.ops.addSourceYoutube(ACC, NB, "https://youtu.be/abcDEF12345")).sourceId).toBe(uuid(21));
  });

  it("text: title 1-200 and content 1-200000, params match the builder, id recorded", async () => {
    const t = setup([() => addResult(30, "Notes"), () => notebookResult([srcRow(30, "Notes", { type: 4, status: 2 })])]);
    const r = await t.ops.addSourceText(ACC, NB, "  Notes ", "hello world");
    expect(r).toMatchObject({ sourceId: uuid(30), title: "Notes", status: "ready" });
    expect(t.calls[0]).toMatchObject({ name: "ADD_SOURCE", kind: "mutate", params: addSourceTextParams(NB, "Notes", "hello world") });
    expect(await t.created.has(ACC, "source", uuid(30))).toBe(true);
    for (const [title, content] of [["", "x"], ["   ", "x"], ["x".repeat(201), "x"], ["ok", ""], ["ok", "   "], ["ok", "x".repeat(200_001)]] as const) {
      await expect(t.ops.addSourceText(ACC, NB, title, content)).rejects.toBeInstanceOf(ZodError);
    }
    expect(t.calls).toHaveLength(2);
    const t2 = setup([() => addResult(31, "Max"), () => notebookResult([])]);
    await t2.ops.addSourceText(ACC, NB, "x".repeat(200), "y".repeat(200_000));
    expect(t2.calls).toHaveLength(2);
  });

  it("text: ambiguous failure is reconciled by title + type + created time", async () => {
    const t = setup([
      boom(new AmbiguousMutationError("izAoDd", "timeout")),
      () => notebookResult([srcRow(2, "Notes", { type: 4, created: NOW_SEC - 86400 }), srcRow(3, "Notes", { type: 4, created: NOW_SEC - 4 }), srcRow(4, "Notes", { type: 5, created: NOW_SEC - 4 })]),
    ]);
    const r = await t.ops.addSourceText(ACC, NB, "Notes", "body");
    expect(r).toMatchObject({ sourceId: uuid(3), reconciled: true });
    expect(names(t.calls)).toEqual(["ADD_SOURCE", "GET_NOTEBOOK"]);
  });

  it("drive: validates file id and mime type, uses the Drive params, reconciles by title", async () => {
    const file = { fileId: "1AbCdEfGhIjKlMnOpQr", mimeType: "application/vnd.google-apps.document" as const, title: "Plan" };
    const t = setup([() => addResult(40, "Plan"), () => notebookResult([srcRow(40, "Plan", { type: 1, status: 1 })])]);
    expect(await t.ops.addSourceDrive(ACC, NB, file)).toMatchObject({ sourceId: uuid(40), status: "processing" });
    expect(t.calls[0]).toMatchObject({ name: "ADD_SOURCE", kind: "mutate", tool: "source_add_drive", params: addSourceDriveParams(NB, file) });
    expect(await t.created.has(ACC, "source", uuid(40))).toBe(true);
    for (const bad of [
      { ...file, fileId: "short" },
      { ...file, fileId: "has spaces in it!!" },
      { ...file, fileId: "a".repeat(129) },
      { ...file, mimeType: "text/html" as never },
      { ...file, title: "" },
    ]) {
      await expect(t.ops.addSourceDrive(ACC, NB, bad)).rejects.toBeInstanceOf(ZodError);
    }
    expect(t.calls).toHaveLength(2);

    const t2 = setup([boom(new AmbiguousMutationError("izAoDd", "HTTP 502")), () => notebookResult([srcRow(41, "Plan", { type: 1, created: NOW_SEC - 2 })])]);
    expect(await t2.ops.addSourceDrive(ACC, NB, file)).toMatchObject({ sourceId: uuid(41), reconciled: true });
  });

  it("rejects non-uuid notebook ids for every add", async () => {
    const t = setup([]);
    await expect(t.ops.addSourceText(ACC, "x", "t", "c")).rejects.toBeInstanceOf(ZodError);
    await expect(t.ops.addSourceYoutube(ACC, "x", "https://youtu.be/abcDEF12345")).rejects.toBeInstanceOf(ZodError);
    await expect(t.ops.addSourceDrive(ACC, "x", { fileId: "1AbCdEfGhIjKlMnOp", mimeType: "application/pdf", title: "t" })).rejects.toBeInstanceOf(ZodError);
    expect(t.calls).toHaveLength(0);
  });
});

describe("getSourceText / getSourceGuide", () => {
  const textResult = (text: string) => [[N, "Doc title"], N, N, [[[0, text.length, [[[0, text.length, [text]]], [N, 1]]]]]];

  it("reads a ready source: notebook lookup (read) then hizoJc (read) with the plain-text params", async () => {
    const t = setup([() => notebookResult([srcRow(5, "Doc", { status: 2 })]), () => textResult("hello ")]);
    const r = await t.ops.getSourceText(ACC, NB, uuid(5));
    expect(r).toEqual({ sourceId: uuid(5), title: "Doc title", text: "hello ", truncated: false, totalChars: 6 });
    expect(names(t.calls)).toEqual(["GET_NOTEBOOK", "SOURCE_TEXT"]);
    expect(t.calls[1]).toMatchObject({ kind: "read", notebookId: NB, params: sourceTextParams(uuid(5)) });
  });

  it("truncates to the safe cap and says so", async () => {
    const big = "a".repeat(SOURCE_TEXT_CAP + 500);
    const t = setup([() => notebookResult([srcRow(5, "Doc")]), () => textResult(big)]);
    const r = await t.ops.getSourceText(ACC, NB, uuid(5));
    expect(r.text).toHaveLength(SOURCE_TEXT_CAP);
    expect(r).toMatchObject({ truncated: true, totalChars: SOURCE_TEXT_CAP + 500 });
    expect(SOURCE_TEXT_CAP).toBe(60_000);
  });

  it("exactly at the cap is not truncated; a cut never splits a surrogate pair", async () => {
    const t = setup([() => notebookResult([srcRow(5, "Doc")]), () => textResult("a".repeat(SOURCE_TEXT_CAP))]);
    expect((await t.ops.getSourceText(ACC, NB, uuid(5))).truncated).toBe(false);
    const emoji = "a".repeat(SOURCE_TEXT_CAP - 1) + "😀😀";
    const t2 = setup([() => notebookResult([srcRow(5, "Doc")]), () => textResult(emoji)]);
    const r = await t2.ops.getSourceText(ACC, NB, uuid(5));
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(SOURCE_TEXT_CAP - 1);
  });

  it("refuses non-ready sources before calling hizoJc, with the status", async () => {
    for (const [code, status] of [[1, "processing"], [5, "preparing"], [3, "error"], [-1, "unknown"]] as const) {
      const t = setup([() => notebookResult([srcRow(5, "Doc", { status: code })])]);
      const e = await t.ops.getSourceText(ACC, NB, uuid(5)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SourceNotReadyError);
      expect((e as SourceNotReadyError).status).toBe(status);
      expect(names(t.calls)).toEqual(["GET_NOTEBOOK"]);
    }
  });

  it("unknown source id and bad ids", async () => {
    const t = setup([() => notebookResult([srcRow(5, "Doc")])]);
    await expect(t.ops.getSourceText(ACC, NB, uuid(99))).rejects.toBeInstanceOf(SourceNotFoundError);
    await expect(t.ops.getSourceText(ACC, NB, "nope")).rejects.toBeInstanceOf(ZodError);
    await expect(t.ops.getSourceGuide(ACC, "nope", uuid(5))).rejects.toBeInstanceOf(ZodError);
    expect(t.calls).toHaveLength(1);
  });

  it("guide: summary + keywords via tr032e; refuses non-ready sources", async () => {
    const guide = [[[N, ["A short summary."], [["alpha", "beta"]]]]];
    const t = setup([() => notebookResult([srcRow(5, "Doc")]), () => guide]);
    expect(await t.ops.getSourceGuide(ACC, NB, uuid(5))).toEqual({ sourceId: uuid(5), title: "Doc", summary: "A short summary.", keywords: ["alpha", "beta"] });
    expect(t.calls[1]).toMatchObject({ name: "SOURCE_GUIDE", kind: "read", params: sourceGuideParams(uuid(5)) });

    const t2 = setup([() => notebookResult([srcRow(5, "Doc", { status: 1 })])]);
    await expect(t2.ops.getSourceGuide(ACC, NB, uuid(5))).rejects.toBeInstanceOf(SourceNotReadyError);
    expect(t2.calls).toHaveLength(1);
  });
});
