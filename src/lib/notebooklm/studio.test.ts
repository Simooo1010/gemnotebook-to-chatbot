// Fixtures are SYNTHETIC (built from docs/PROTOCOL.md §3.4); replace with real captures in the real-data run.
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { RpcCall } from "@/lib/google/client";
import { AmbiguousMutationError, CooldownActiveError, DailyCapReachedError } from "@/lib/google/errors";
import { MemoryUsageCounter, createThrottle } from "@/lib/google/throttle";
import { fakeClock } from "@/lib/google/testing";
import { RpcAuthError, RpcDriftError, RpcQuotaError } from "@/lib/rpc/errors";
import type { NotebookDetail, Source } from "@/lib/rpc/rows";
import { MemoryCreatedObjects } from "./created";
import {
  AUDIO_FORMATS,
  AUDIO_LENGTHS,
  ArtifactNotDownloadableError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  NEXT_CHECK_SECONDS,
  NotEnoughReadySourcesError,
  STATUS_PAGE_SIZE,
  StudioCreateAmbiguousError,
  StudioCreateUnconfirmedError,
  createStudioOps,
  studioStatusOf,
} from "./studio";
import { decodeArtifactRow } from "@/lib/rpc/rows";

const N = null;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ACC = "acc-1";
const NB = uuid(1);
const S1 = uuid(11);
const S2 = uuid(12);
const S3 = uuid(13);
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);
const CA = [2, N, N, [1, N, N, N, N, N, N, N, N, N, [1]], [[1, 4, 8, 2, 3, 6]]];

const src = (id: string, status: Source["status"]): Source => ({ id, title: id, typeCode: 5, type: "web_page", status, url: N, wordCount: N, createdSec: N });
const nb = (...sources: Source[]) => ({ id: NB, title: "T", sources }) as unknown as NotebookDetail;

interface RowSpec {
  type?: 1 | 2 | 3;
  status?: number;
  media?: boolean;
  created?: number | null;
  title?: string;
}
const artRow = (id: string, o: RowSpec = {}) => {
  const type = o.type ?? 1;
  const r: unknown[] = Array<unknown>(16).fill(N);
  r[0] = id;
  r[1] = o.title ?? `Title ${id}`;
  r[2] = type;
  r[4] = o.status ?? 2;
  if (o.media && type === 1) r[6] = [N, N, N, N, N, [[`https://lh3.googleusercontent.com/${id}-dv`, 1, "audio/mp4"]]];
  if (o.media && type === 3) r[8] = [N, N, N, N, [[`https://lh3.googleusercontent.com/${id}`, 4, "video/mp4"]]];
  r[15] = o.created === null ? N : [o.created ?? NOW_SEC - 86_400];
  return r;
};
const listResult = (...rows: unknown[]) => [rows];
const createResult = (id: string, type: number, status = 1) => [[id, "Overview", type, N, status]];

type Responder = (c: RpcCall) => unknown;
/** Scripted client: responders are consumed per rpc name, in order. */
function fakeClient(script: { LIST_ARTIFACTS?: Responder[]; CREATE_ARTIFACT?: Responder[] }, wrap?: (c: RpcCall, run: () => Promise<unknown>) => Promise<unknown>) {
  const calls: RpcCall[] = [];
  const q = { LIST_ARTIFACTS: [...(script.LIST_ARTIFACTS ?? [])], CREATE_ARTIFACT: [...(script.CREATE_ARTIFACT ?? [])] };
  return {
    calls,
    client: {
      async rpc(c: RpcCall) {
        calls.push(c);
        const run = async () => {
          const r = q[c.name as "LIST_ARTIFACTS" | "CREATE_ARTIFACT"]?.shift();
          if (!r) throw new Error(`unexpected rpc ${c.name}`);
          return r(c);
        };
        return wrap ? wrap(c, run) : run();
      },
    },
    names: () => calls.map((c) => c.name),
  };
}
const boom = (e: unknown): Responder => () => {
  throw e;
};
const ret = (v: unknown): Responder => () => v;

function setup(
  sources: Source[],
  script: Parameters<typeof fakeClient>[0],
  wrap?: Parameters<typeof fakeClient>[1],
) {
  const f = fakeClient(script, wrap);
  const created = new MemoryCreatedObjects();
  const getNotebook = vi.fn(async () => nb(...sources));
  const ops = createStudioOps({ client: f.client, created, notebooks: { getNotebook }, now: () => NOW });
  return { ...f, created, ops, getNotebook };
}
const createCall = (calls: RpcCall[]) => calls.filter((c) => c.name === "CREATE_ARTIFACT");

describe("option -> code mapping (SPEC §2 / PROTOCOL §3.4)", () => {
  const sourceIds = [S1, S2];
  const triple = [[[S1]], [[S2]]];
  const ids2 = [[S1], [S2]];

  const audioCases = (Object.entries(AUDIO_FORMATS) as [keyof typeof AUDIO_FORMATS, number][]).flatMap(([format, fcode]) =>
    (Object.entries(AUDIO_LENGTHS) as [keyof typeof AUDIO_LENGTHS, number][]).map(([length, lcode]) => [format, fcode, length, lcode] as const),
  );
  it("covers every audio format x length (12) with the documented array", async () => {
    expect(audioCases).toHaveLength(12);
    expect(audioCases.map((c) => c[1])).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    for (const [format, fcode, length, lcode] of audioCases) {
      const s = setup([src(S1, "ready"), src(S2, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("a1", 1))] });
      await s.ops.createAudioOverview(ACC, NB, { format, length, language: "it", focusPrompt: "  the money part  " });
      expect(createCall(s.calls)[0]!.params).toEqual([
        CA,
        NB,
        [N, N, 1, triple, N, N, [N, ["the money part", lcode, N, ids2, "it", N, fcode]]],
      ]);
    }
  });

  it("audio defaults: deep dive, default length, 'en', no focus, all ready sources", async () => {
    const s = setup([src(S1, "ready"), src(S2, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("a1", 1))] });
    await s.ops.createAudioOverview(ACC, NB);
    expect(createCall(s.calls)[0]!.params).toEqual([CA, NB, [N, N, 1, triple, N, N, [N, [N, 2, N, ids2, "en", N, 1]]]]);
    expect(createCall(s.calls)[0]).toMatchObject({ kind: "mutate", usageKind: "audio", notebookId: NB });
    void sourceIds;
  });

  const styles = { auto: 1, classic: 2, whiteboard: 3, heritage: 4, paper_craft: 5, watercolor: 6, anime: 7, retro_print: 8, kawaii: 9 } as const;
  const videoCases = ([["explainer", 1], ["brief", 2]] as const).flatMap(([format, fcode]) =>
    [...(Object.entries(styles) as [keyof typeof styles, number][]).map(([style, code]) => ({ format, fcode, style, tail: [code] as unknown[], stylePrompt: undefined as string | undefined })),
      { format, fcode, style: "custom" as const, tail: [N, "ink on parchment"] as unknown[], stylePrompt: "ink on parchment" }],
  );
  it("covers every video format x style incl. custom (20) with the documented array and the CA options block", async () => {
    expect(videoCases).toHaveLength(20);
    for (const c of videoCases) {
      const s = setup([src(S1, "ready"), src(S2, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("v1", 3))] });
      await s.ops.createVideoOverview(ACC, NB, { format: c.format, style: c.style, stylePrompt: c.stylePrompt, language: "de", focusPrompt: "focus" });
      expect(createCall(s.calls)[0]!.params).toEqual([
        CA,
        NB,
        [N, N, 3, triple, N, N, N, N, [N, N, [ids2, "de", "focus", N, c.fcode, ...c.tail]]],
      ]);
      expect(createCall(s.calls)[0]).toMatchObject({ kind: "mutate", usageKind: "video" });
    }
  });

  it("video defaults: explainer, auto style", async () => {
    const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("v1", 3))] });
    await s.ops.createVideoOverview(ACC, NB, {});
    expect(createCall(s.calls)[0]!.params).toEqual([CA, NB, [N, N, 3, [[[S1]]], N, N, N, N, [N, N, [[[S1]], "en", N, N, 1, 1]]]]);
  });

  it("custom style needs a stylePrompt, and a prompt needs the custom style; limits are enforced before any call", async () => {
    const s = setup([src(S1, "ready")], {});
    const bad = [
      { style: "custom" as const },
      { style: "kawaii" as const, stylePrompt: "x" },
      { style: "custom" as const, stylePrompt: "y".repeat(501) },
      { focusPrompt: "z".repeat(2001) },
      { language: "english please" },
      { sourceIds: ["not-a-uuid"] },
      { style: "cinematic" as never },
      { format: "short" as never },
    ];
    for (const o of bad) await expect(s.ops.createVideoOverview(ACC, NB, o)).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.createAudioOverview(ACC, NB, { format: "interview" as never })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.createAudioOverview(ACC, NB, { focusPrompt: "z".repeat(2001) })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.createAudioOverview(ACC, "nope")).rejects.toBeInstanceOf(ZodError);
    expect(s.calls).toHaveLength(0);
    expect(s.getNotebook).not.toHaveBeenCalled();
    await expect(s.ops.createVideoOverview(ACC, NB, { style: "custom", stylePrompt: "y".repeat(500) })).rejects.not.toBeInstanceOf(ZodError); // 500 is allowed (fails later: no scripted rpc)
  });
});

describe("pre-flight (reads only, no mutation)", () => {
  const refused = async (sources: Source[], opts: Parameters<ReturnType<typeof createStudioOps>["createAudioOverview"]>[2], reason: string, counts: { total: number; ready: number }) => {
    const s = setup(sources, {});
    const e = await s.ops.createAudioOverview(ACC, NB, opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotEnoughReadySourcesError);
    expect(e).toMatchObject({ reason, counts });
    expect(createCall(s.calls)).toHaveLength(0);
    expect(s.calls).toHaveLength(0); // not even a list
  };
  it("refuses a notebook without sources", () => refused([], undefined, "no_sources", { total: 0, ready: 0 }));
  it("refuses when no source is ready yet", () => refused([src(S1, "processing"), src(S2, "preparing"), src(S3, "error")], undefined, "none_ready", { total: 3, ready: 0 }));
  it("refuses explicit sourceIds that are unknown or not ready", async () => {
    await refused([src(S1, "ready")], { sourceIds: [S1, S2] }, "selected_unknown", { total: 1, ready: 1 });
    await refused([src(S1, "ready"), src(S2, "processing")], { sourceIds: [S1, S2] }, "selected_not_ready", { total: 2, ready: 1 });
  });
  it("default uses only the READY sources; explicit ids are used as given (de-duplicated)", async () => {
    const a = setup([src(S1, "ready"), src(S2, "processing"), src(S3, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("a1", 1))] });
    const r = await a.ops.createAudioOverview(ACC, NB);
    expect(r.sourceCount).toBe(2);
    expect((createCall(a.calls)[0]!.params as unknown[][])[2]![3]).toEqual([[[S1]], [[S3]]]);
    const b = setup([src(S1, "ready"), src(S2, "ready"), src(S3, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("a1", 1))] });
    await b.ops.createVideoOverview(ACC, NB, { sourceIds: [S3, S3, S1] });
    expect((createCall(b.calls)[0]!.params as unknown[][])[2]![3]).toEqual([[[S3]], [[S1]]]);
  });
});

describe("create", () => {
  it("returns the artifact id and status at once (one create call, no polling) and records it in created_objects", async () => {
    const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("art-A", 1, 1))] });
    const r = await s.ops.createAudioOverview(ACC, NB);
    expect(r).toEqual({ artifactId: "art-A", type: "audio", status: "queued", reconciled: false, sourceCount: 1 });
    expect(s.names()).toEqual(["LIST_ARTIFACTS", "CREATE_ARTIFACT"]); // pre-create snapshot, then create; nothing after
    expect(await s.created.list(ACC, "artifact")).toEqual(["art-A"]);
    const v = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("art-V", 3, 2))] });
    expect(await v.ops.createVideoOverview(ACC, NB)).toMatchObject({ artifactId: "art-V", type: "video", status: "generating" });
  });

  it("a failed bookkeeping write does not turn a successful create into a failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakeClient({ LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [ret(createResult("art-A", 1))] });
    const created = { record: async () => { throw new Error("db down"); }, has: async () => false, list: async () => [] };
    const ops = createStudioOps({ client: f.client, created, notebooks: { getNotebook: async () => nb(src(S1, "ready")) }, now: () => NOW });
    await expect(ops.createAudioOverview(ACC, NB)).resolves.toMatchObject({ artifactId: "art-A" });
    spy.mockRestore();
  });

  describe("ambiguous failure -> reconcile by listing, never a second create", () => {
    const unclear = () => new AmbiguousMutationError("R7cb6c", "timeout");
    it("finds the one new matching artifact (type + created after request start), records it, and creates exactly once", async () => {
      const old = artRow("old-audio", { type: 1, status: 3, media: true, created: NOW_SEC - 86_400 });
      const fresh = artRow("new-audio", { type: 1, status: 2, created: NOW_SEC + 2 });
      const otherType = artRow("new-video", { type: 3, status: 2, created: NOW_SEC + 2 });
      const s = setup([src(S1, "ready")], {
        LIST_ARTIFACTS: [ret(listResult(old)), ret(listResult(old, fresh, otherType))],
        CREATE_ARTIFACT: [boom(unclear())],
      });
      const r = await s.ops.createAudioOverview(ACC, NB);
      expect(r).toMatchObject({ artifactId: "new-audio", type: "audio", status: "generating", reconciled: true });
      expect(createCall(s.calls)).toHaveLength(1);
      expect(s.names()).toEqual(["LIST_ARTIFACTS", "CREATE_ARTIFACT", "LIST_ARTIFACTS"]);
      expect(await s.created.list(ACC, "artifact")).toEqual(["new-audio"]);
    });

    it("a stale artifact with a created time before the window is not matched; nothing found -> unconfirmed (not retried)", async () => {
      const stale = artRow("stale", { type: 1, created: NOW_SEC - 3600 });
      const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult()), ret(listResult(stale))], CREATE_ARTIFACT: [boom(unclear())] });
      const e = await s.ops.createAudioOverview(ACC, NB).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StudioCreateUnconfirmedError);
      expect(createCall(s.calls)).toHaveLength(1);
      expect(await s.created.list(ACC, "artifact")).toEqual([]);
    });

    it("an artifact that already existed before the request is never claimed", async () => {
      const existing = artRow("existing", { type: 1, status: 2, created: NOW_SEC });
      const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult(existing)), ret(listResult(existing))], CREATE_ARTIFACT: [boom(unclear())] });
      await expect(s.ops.createAudioOverview(ACC, NB)).rejects.toBeInstanceOf(StudioCreateUnconfirmedError);
    });

    it("several new candidates -> ambiguous, nothing recorded", async () => {
      const a = artRow("n1", { type: 3, created: NOW_SEC });
      const b = artRow("n2", { type: 3, created: NOW_SEC + 1 });
      const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult()), ret(listResult(a, b))], CREATE_ARTIFACT: [boom(unclear())] });
      const e = await s.ops.createVideoOverview(ACC, NB).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StudioCreateAmbiguousError);
      expect((e as StudioCreateAmbiguousError).candidateIds).toEqual(["n1", "n2"]);
      expect(await s.created.list(ACC, "artifact")).toEqual([]);
    });

    it("an unreadable create response (drift) is reconciled too; a failing re-list reports the original ambiguity", async () => {
      const fresh = artRow("new-video", { type: 3, status: 1, created: null });
      const a = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult()), ret(listResult(fresh))], CREATE_ARTIFACT: [ret([[]])] });
      await expect(a.ops.createVideoOverview(ACC, NB)).resolves.toMatchObject({ artifactId: "new-video", reconciled: true, status: "queued" });
      const original = unclear();
      const b = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult()), boom(new Error("list down"))], CREATE_ARTIFACT: [boom(original)] });
      await expect(b.ops.createAudioOverview(ACC, NB)).rejects.toBe(original);
      void RpcDriftError;
    });

    it("quota, cooldown and auth errors are surfaced as they are: no re-list, no retry", async () => {
      for (const e of [new RpcQuotaError("R7cb6c", "user_displayable"), new CooldownActiveError(ACC, 30_000), new RpcAuthError("R7cb6c", "grpc_16")]) {
        const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret(listResult())], CREATE_ARTIFACT: [boom(e)] });
        await expect(s.ops.createAudioOverview(ACC, NB)).rejects.toBe(e);
        expect(s.names()).toEqual(["LIST_ARTIFACTS", "CREATE_ARTIFACT"]);
      }
    });
  });

  describe("daily caps (throttle, per account)", () => {
    function capped(caps: { audio?: number; video?: number }, createCount: number) {
      const clock = fakeClock(NOW);
      const throttle = createThrottle({ usage: new MemoryUsageCounter(), caps, now: clock.now, sleep: clock.sleep, random: () => 0 });
      const wrap = (c: RpcCall, run: () => Promise<unknown>) => throttle.schedule(c.accountId, run, { usageKind: c.usageKind });
      const lists = Array.from({ length: createCount }, () => ret(listResult()));
      const creates = Array.from({ length: createCount }, (_, i) => ret(createResult(`art-${i}`, 1)));
      return setup([src(S1, "ready")], { LIST_ARTIFACTS: lists, CREATE_ARTIFACT: creates }, wrap);
    }
    it("passes usageKind so the cap applies; the cap+1th create is refused before any create call", async () => {
      const s = capped({ audio: 2 }, 3);
      await s.ops.createAudioOverview(ACC, NB);
      await s.ops.createAudioOverview(ACC, NB);
      const e = await s.ops.createAudioOverview(ACC, NB).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DailyCapReachedError);
      expect(e).toMatchObject({ usageKind: "audio", cap: 2 });
      expect(createCall(s.calls)).toHaveLength(3); // the third reached the (capped) client wrapper but the throttle refused it...
      expect(await s.created.list(ACC, "artifact")).toEqual(["art-0", "art-1"]); // ...so nothing was created or recorded
    });
    it("audio and video are counted separately", async () => {
      const s = capped({ audio: 1, video: 1 }, 2);
      await s.ops.createAudioOverview(ACC, NB);
      await expect(s.ops.createVideoOverview(ACC, NB)).resolves.toMatchObject({ type: "video" }); // video has its own counter
    });
  });
});

describe("status", () => {
  const ready = (id: string, type: 1 | 3, created = NOW_SEC - 100) => artRow(id, { type, status: 3, media: true, created });
  it("maps status codes and readyMedia (1 and 2 = not done; 3 ready only with media; 4 failed)", () => {
    const st = (r: unknown) => studioStatusOf(decodeArtifactRow(r, "gArtLc"));
    expect(st(artRow("a", { status: 1 }))).toBe("queued");
    expect(st(artRow("a", { status: 2 }))).toBe("generating");
    expect(st(artRow("a", { status: 3, media: false }))).toBe("generating"); // done but no media URL yet
    expect(st(artRow("a", { status: 3, media: true }))).toBe("ready");
    expect(st(artRow("v", { type: 3, status: 3, media: false }))).toBe("generating");
    expect(st(artRow("v", { type: 3, status: 3, media: true }))).toBe("ready");
    expect(st(artRow("a", { status: 4 }))).toBe("failed");
    expect(st(artRow("a", { status: 0 }))).toBe("queued");
    expect(st(artRow("r", { type: 2, status: 3 }))).toBe("ready"); // non-media artifacts need no media
  });

  it("returns compact rows newest first, with a >= 15 s hint while something runs", async () => {
    const rows = [ready("old", 1, NOW_SEC - 5000), artRow("gen", { type: 3, status: 2, created: NOW_SEC - 10 }), artRow("rep", { type: 2, status: 3, created: NOW_SEC - 50 }), artRow("bad", { type: 1, status: 4, created: NOW_SEC - 2000 })];
    const s = setup([], { LIST_ARTIFACTS: [ret(listResult(...rows))] });
    const r = await s.ops.getStudioStatus(ACC, NB);
    expect(r.artifacts.map((a) => a.artifactId)).toEqual(["gen", "rep", "bad", "old"]);
    expect(r.artifacts[0]).toEqual({ artifactId: "gen", type: "video", title: "Title gen", status: "generating", readyMedia: false, createdAt: new Date((NOW_SEC - 10) * 1000).toISOString() });
    expect(r.artifacts.find((a) => a.artifactId === "old")).toMatchObject({ type: "audio", status: "ready", readyMedia: true });
    expect(r.artifacts.find((a) => a.artifactId === "rep")).toMatchObject({ type: "other", status: "ready", readyMedia: false });
    expect(r.artifacts.find((a) => a.artifactId === "bad")).toMatchObject({ status: "failed", readyMedia: false });
    expect(r.nextCheckInSeconds).toBeGreaterThanOrEqual(15);
    expect(r.nextCheckInSeconds).toBe(NEXT_CHECK_SECONDS);
    expect(s.calls[0]).toMatchObject({ name: "LIST_ARTIFACTS", kind: "read" });
    expect(JSON.stringify(r)).not.toContain("googleusercontent"); // no media URL in the status
  });

  it("nothing running -> hint 0; filter by artifactId or type; unknown id -> not found; list is capped", async () => {
    const rows = [ready("a1", 1), ready("v1", 3, NOW_SEC - 200)];
    const a = setup([], { LIST_ARTIFACTS: [ret(listResult(...rows)), ret(listResult(...rows)), ret(listResult(...rows))] });
    expect((await a.ops.getStudioStatus(ACC, NB)).nextCheckInSeconds).toBe(0);
    expect((await a.ops.getStudioStatus(ACC, NB, { artifactId: "v1" })).artifacts.map((x) => x.artifactId)).toEqual(["v1"]);
    expect((await a.ops.getStudioStatus(ACC, NB, { type: "audio" })).artifacts.map((x) => x.artifactId)).toEqual(["a1"]);
    const b = setup([], { LIST_ARTIFACTS: [ret(listResult(...rows))] });
    await expect(b.ops.getStudioStatus(ACC, NB, { artifactId: "nope" })).rejects.toBeInstanceOf(ArtifactNotFoundError);
    const many = Array.from({ length: 30 }, (_, i) => ready(`m${i}`, 1, NOW_SEC - i));
    const c = setup([], { LIST_ARTIFACTS: [ret(listResult(...many))] });
    const r = await c.ops.getStudioStatus(ACC, NB);
    expect(r.artifacts).toHaveLength(STATUS_PAGE_SIZE);
    expect(r.total).toBe(30);
  });

  it("empty notebook -> no rows", async () => {
    const s = setup([], { LIST_ARTIFACTS: [ret(N)] });
    expect(await s.ops.getStudioStatus(ACC, NB)).toEqual({ artifacts: [], total: 0, nextCheckInSeconds: 0 });
  });
});

describe("notebook with no artifacts yet (T3-1: real Google answers '[]')", () => {
  it("studio_status works on the real empty-list shape, and so does the pre-create snapshot of a first audio/video overview", async () => {
    const s = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret([])] });
    expect(await s.ops.getStudioStatus(ACC, NB)).toEqual({ artifacts: [], total: 0, nextCheckInSeconds: 0 });
    const a = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret([])], CREATE_ARTIFACT: [ret(createResult("art-A", 1, 1))] });
    expect(await a.ops.createAudioOverview(ACC, NB)).toMatchObject({ artifactId: "art-A", status: "queued" });
    const v = setup([src(S1, "ready")], { LIST_ARTIFACTS: [ret([N])], CREATE_ARTIFACT: [ret(createResult("art-V", 3, 1))] });
    expect(await v.ops.createVideoOverview(ACC, NB)).toMatchObject({ artifactId: "art-V", type: "video" });
  });
});

describe("getMedia (fresh URL, server side only)", () => {
  it("re-lists and returns the current media url for a ready audio/video", async () => {
    const s = setup([], { LIST_ARTIFACTS: [ret(listResult(artRow("a1", { type: 1, status: 3, media: true }), artRow("v1", { type: 3, status: 3, media: true })))] });
    expect(await s.ops.getMedia(ACC, NB, "v1")).toEqual({ artifactId: "v1", kind: "video", title: "Title v1", url: "https://lh3.googleusercontent.com/v1", mime: "video/mp4" });
    expect(s.calls[0]).toMatchObject({ name: "LIST_ARTIFACTS", kind: "read", tool: "studio_download_link" });
  });
  it("refuses unknown, not-ready, failed and non-media artifacts with typed errors", async () => {
    const rows = [artRow("gen", { type: 1, status: 2 }), artRow("nomedia", { type: 3, status: 3, media: false }), artRow("bad", { type: 1, status: 4 }), artRow("rep", { type: 2, status: 3 })];
    const get = async (id: string) => {
      const s = setup([], { LIST_ARTIFACTS: [ret(listResult(...rows))] });
      return s.ops.getMedia(ACC, NB, id).catch((x: unknown) => x);
    };
    expect(await get("zzz")).toBeInstanceOf(ArtifactNotFoundError);
    expect(await get("gen")).toMatchObject({ kind: "artifact_not_ready", status: "generating" });
    expect(await get("nomedia")).toBeInstanceOf(ArtifactNotReadyError);
    expect(await get("bad")).toMatchObject({ status: "failed" });
    expect(await get("rep")).toBeInstanceOf(ArtifactNotDownloadableError);
  });
});
