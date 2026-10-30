// Studio operations: audio and video overviews (SPEC §2, §3, PROTOCOL §3.4).
// Creating is a mutation: never auto-retried, never waits for the result (generation takes minutes to 30+ minutes).
// After an ambiguous failure the artifact list is re-read to reconcile before reporting, so nothing is created twice.
import { z } from "zod";
import type { GoogleClient } from "@/lib/google/client";
import { AmbiguousMutationError } from "@/lib/google/errors";
import { POLL_FLOOR_MS } from "@/lib/google/throttle";
import { RpcDriftError, RpcStatusError } from "@/lib/rpc/errors";
import { resolveRpcId } from "@/lib/rpc/ids";
import {
  AudioFormat,
  AudioLength,
  VideoFormat,
  createAudioParams,
  createVideoParams,
  listArtifactsParams,
  type VideoInput,
} from "@/lib/rpc/params";
import { decodeArtifactList, decodeCreateArtifact, type Artifact } from "@/lib/rpc/rows";
import type { CreatedObjects } from "./created";
import type { MediaKind } from "./media-link";
import type { NotebookOps } from "./notebooks";

export const MAX_FOCUS_PROMPT_CHARS = 2000;
export const MAX_STYLE_PROMPT_CHARS = 500;
export const MAX_SOURCE_IDS = 300;
/** Hint for Claude: poll no more often than this (the throttle enforces the same floor). */
export const NEXT_CHECK_SECONDS = Math.ceil(POLL_FLOOR_MS / 1000);
/** An artifact counts as "just created" if Google stamped it within this window before our request. */
const RECONCILE_WINDOW_MS = 60_000;
export const STATUS_PAGE_SIZE = 20;

// --- option values (SPEC §2). cinematic and short video formats are NOT offered. ---
export const AUDIO_FORMATS = { deep_dive: AudioFormat.DeepDive, brief: AudioFormat.Brief, critique: AudioFormat.Critique, debate: AudioFormat.Debate } as const;
export const AUDIO_LENGTHS = { short: AudioLength.Short, default: AudioLength.Default, long: AudioLength.Long } as const;
export const VIDEO_FORMATS = { explainer: VideoFormat.Explainer, brief: VideoFormat.Brief } as const;
/** Tool value -> params.ts style key (PY live-captured table, PROTOCOL §3.4). */
export const VIDEO_STYLE_KEYS = {
  auto: "auto",
  classic: "classic",
  whiteboard: "whiteboard",
  heritage: "heritage",
  paper_craft: "paper-craft",
  watercolor: "watercolor",
  anime: "anime",
  retro_print: "retro-print",
  kawaii: "kawaii",
  custom: "custom",
} as const;

// --- validation ---
export const notebookIdSchema = z.string().uuid();
export const artifactIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "invalid artifact id");
const languageSchema = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "language must look like 'en' or 'pt-BR'");
const focusSchema = z.string().trim().max(MAX_FOCUS_PROMPT_CHARS);
const sourceIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_SOURCE_IDS);

export const audioShape = {
  format: z.enum(["deep_dive", "brief", "critique", "debate"]).default("deep_dive"),
  length: z.enum(["short", "default", "long"]).default("default"),
  language: languageSchema.default("en"),
  focusPrompt: focusSchema.optional(),
  sourceIds: sourceIdsSchema.optional(),
};
export const audioOptionsSchema = z.object(audioShape);
export type AudioOptions = z.input<typeof audioOptionsSchema>;

export const videoShape = {
  format: z.enum(["explainer", "brief"]).default("explainer"),
  style: z.enum(["auto", "classic", "whiteboard", "heritage", "paper_craft", "watercolor", "anime", "retro_print", "kawaii", "custom"]).default("auto"),
  stylePrompt: z.string().trim().min(1).max(MAX_STYLE_PROMPT_CHARS).optional(),
  language: languageSchema.default("en"),
  focusPrompt: focusSchema.optional(),
  sourceIds: sourceIdsSchema.optional(),
};
/** Custom style needs a prompt; a prompt without the custom style is refused rather than silently dropped. */
export const videoStyleRuleOk = (v: { style: string; stylePrompt?: string }): boolean => (v.style === "custom") === (v.stylePrompt !== undefined);
export const VIDEO_STYLE_RULE = { message: "stylePrompt is required when style is 'custom' and not allowed otherwise", path: ["stylePrompt"] };
export const videoOptionsSchema = z.object(videoShape).refine(videoStyleRuleOk, VIDEO_STYLE_RULE);
export type VideoOptions = z.input<typeof videoOptionsSchema>;

// --- errors ---
export type NotEnoughSourcesReason = "no_sources" | "none_ready" | "selected_unknown" | "selected_not_ready";

/** Pre-flight refusal: nothing was sent to Google's create endpoint. */
export class NotEnoughReadySourcesError extends Error {
  readonly kind = "not_enough_ready_sources";
  constructor(
    readonly reason: NotEnoughSourcesReason,
    readonly counts: { total: number; ready: number },
  ) {
    super(`not enough ready sources (${reason}): ${counts.ready} of ${counts.total} ready`);
  }
}

/** The create call failed ambiguously and no new artifact shows up. Nothing is recorded; never retried automatically. */
export class StudioCreateUnconfirmedError extends Error {
  readonly kind = "studio_create_unconfirmed";
  constructor(readonly cause: unknown) {
    super("the overview request was not confirmed: no new matching artifact after re-reading the notebook");
  }
}

/** Several new artifacts could be the result: nothing was recorded. */
export class StudioCreateAmbiguousError extends Error {
  readonly kind = "studio_create_ambiguous";
  constructor(readonly candidateIds: string[]) {
    super(`the overview request was ambiguous: ${candidateIds.length} new artifacts match`);
  }
}

export class ArtifactNotFoundError extends Error {
  readonly kind = "artifact_not_found";
  constructor() {
    super("artifact not found in this notebook");
  }
}

export class ArtifactNotReadyError extends Error {
  readonly kind = "artifact_not_ready";
  constructor(readonly status: StudioStatus) {
    super(`artifact is not ready (status ${status})`);
  }
}

/** Only audio and video overviews can be downloaded in v1. */
export class ArtifactNotDownloadableError extends Error {
  readonly kind = "artifact_not_downloadable";
  constructor() {
    super("only audio and video overviews can be downloaded");
  }
}

// --- results ---
export type StudioType = "audio" | "video" | "other";
export type StudioStatus = "queued" | "generating" | "ready" | "failed";

export interface CreatedOverview {
  artifactId: string;
  type: "audio" | "video";
  status: "queued" | "generating";
  /** True when the create had an unclear outcome and the artifact was found by re-reading the notebook. */
  reconciled: boolean;
  /** How many ready sources the overview is built from. */
  sourceCount: number;
}

export interface StudioRow {
  artifactId: string;
  type: StudioType;
  title: string | null;
  status: StudioStatus;
  readyMedia: boolean;
  createdAt: string | null;
}

export interface StudioStatusResult {
  artifacts: StudioRow[];
  /** Number of artifacts matching the filter (the list is capped at STATUS_PAGE_SIZE, newest first). */
  total: number;
  /** Seconds to wait before checking again; 0 when nothing is still running. */
  nextCheckInSeconds: number;
}

export interface MediaTarget {
  artifactId: string;
  kind: MediaKind;
  title: string | null;
  /** Fresh Google URL. Server-side only: never returned by a tool, never stored, never logged. */
  url: string;
  mime: string;
}

const typeOf = (a: Artifact): StudioType => (a.typeCode === 1 ? "audio" : a.typeCode === 3 ? "video" : "other");

export function studioStatusOf(a: Artifact): StudioStatus {
  if (a.statusCode === 4) return "failed";
  if (a.state === "ready") return "ready";
  if (a.statusCode === 2 || a.statusCode === 3) return "generating"; // 3 without media: finishing up
  return "queued";
}

const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());

export interface StudioOpsDeps {
  client: Pick<GoogleClient, "rpc">;
  created: CreatedObjects;
  notebooks: Pick<NotebookOps, "getNotebook">;
  rpcOverridesJson?: string | null;
  now?: () => number;
}

/** Unclear outcomes: the write may have happened. Quota errors are NOT among them: they are surfaced as they are. */
const isUnclear = (e: unknown): boolean => e instanceof AmbiguousMutationError || e instanceof RpcStatusError || e instanceof RpcDriftError;

export function createStudioOps(deps: StudioOpsDeps) {
  const now = deps.now ?? Date.now;
  const rpcId = (n: "CREATE_ARTIFACT" | "LIST_ARTIFACTS") => resolveRpcId(n, deps.rpcOverridesJson);

  async function listArtifacts(accountId: string, notebookId: string, tool: string): Promise<Artifact[]> {
    const result = await deps.client.rpc({
      accountId,
      name: "LIST_ARTIFACTS",
      params: listArtifactsParams(notebookId),
      notebookId,
      kind: "read",
      tool,
    });
    return decodeArtifactList(result, rpcId("LIST_ARTIFACTS"));
  }

  /** Reads: the notebook must have READY sources. Default = all ready sources; explicit ids must all be ready. */
  async function chooseSources(accountId: string, notebookId: string, wanted: string[] | undefined): Promise<string[]> {
    const nb = await deps.notebooks.getNotebook(accountId, notebookId);
    const counts = { total: nb.sources.length, ready: nb.sources.filter((s) => s.status === "ready").length };
    if (counts.total === 0) throw new NotEnoughReadySourcesError("no_sources", counts);
    if (wanted) {
      const byId = new Map(nb.sources.map((s) => [s.id, s]));
      const unique = [...new Set(wanted)];
      for (const id of unique) if (!byId.has(id)) throw new NotEnoughReadySourcesError("selected_unknown", counts);
      for (const id of unique) if (byId.get(id)!.status !== "ready") throw new NotEnoughReadySourcesError("selected_not_ready", counts);
      return unique;
    }
    const ready = nb.sources.filter((s) => s.status === "ready").map((s) => s.id);
    if (ready.length === 0) throw new NotEnoughReadySourcesError("none_ready", counts);
    return ready;
  }

  async function record(accountId: string, artifactId: string): Promise<void> {
    try {
      await deps.created.record(accountId, "artifact", artifactId);
    } catch (e) {
      // The artifact exists already; a failed bookkeeping write must not look like a failed create.
      console.error("created_objects record failed:", e instanceof Error ? e.name : typeof e);
    }
  }

  async function create(
    accountId: string,
    notebookId: string,
    type: "audio" | "video",
    wantedSources: string[] | undefined,
    build: (sourceIds: string[]) => unknown[],
  ): Promise<CreatedOverview> {
    const sourceIds = await chooseSources(accountId, notebookId, wantedSources);
    const params = build(sourceIds); // validate the whole request before touching the network again
    const tool = type === "audio" ? "studio_audio_create" : "studio_video_create";
    // Snapshot of the existing artifacts: lets an ambiguous failure be told apart from older overviews.
    const before = new Set((await listArtifacts(accountId, notebookId, tool)).map((a) => a.id));
    const startedAt = now();
    try {
      const result = await deps.client.rpc({
        accountId,
        name: "CREATE_ARTIFACT",
        params,
        notebookId,
        kind: "mutate",
        usageKind: type,
        tool,
      });
      const d = decodeCreateArtifact(result, rpcId("CREATE_ARTIFACT"));
      await record(accountId, d.id);
      return { artifactId: d.id, type, status: d.statusCode === 2 ? "generating" : "queued", reconciled: false, sourceCount: sourceIds.length };
    } catch (e) {
      if (!isUnclear(e)) throw e; // quota, daily cap, cooldown, auth: reported as they are, never retried
      let after: Artifact[];
      try {
        after = await listArtifacts(accountId, notebookId, tool);
      } catch {
        throw e; // could not look: report the original ambiguity
      }
      const wantCode = type === "audio" ? 1 : 3;
      const known = new Set(await deps.created.list(accountId, "artifact").catch(() => [] as string[]));
      const candidates = after.filter(
        (a) =>
          a.typeCode === wantCode &&
          !before.has(a.id) &&
          !known.has(a.id) &&
          (a.createdSec === null || a.createdSec * 1000 >= startedAt - RECONCILE_WINDOW_MS),
      );
      if (candidates.length === 0) throw new StudioCreateUnconfirmedError(e);
      if (candidates.length > 1) throw new StudioCreateAmbiguousError(candidates.map((c) => c.id));
      const found = candidates[0]!;
      await record(accountId, found.id);
      const st = studioStatusOf(found);
      return { artifactId: found.id, type, status: st === "generating" || st === "ready" ? "generating" : "queued", reconciled: true, sourceCount: sourceIds.length };
    }
  }

  async function createAudioOverview(accountId: string, notebookId: string, opts: AudioOptions = {}): Promise<CreatedOverview> {
    const nb = notebookIdSchema.parse(notebookId);
    const o = audioOptionsSchema.parse(opts);
    return create(accountId, nb, "audio", o.sourceIds, (sourceIds) =>
      createAudioParams({
        notebookId: nb,
        sourceIds,
        format: AUDIO_FORMATS[o.format],
        length: AUDIO_LENGTHS[o.length],
        language: o.language,
        focusPrompt: o.focusPrompt || null,
      }),
    );
  }

  async function createVideoOverview(accountId: string, notebookId: string, opts: VideoOptions = {}): Promise<CreatedOverview> {
    const nb = notebookIdSchema.parse(notebookId);
    const o = videoOptionsSchema.parse(opts);
    return create(accountId, nb, "video", o.sourceIds, (sourceIds) => {
      const input: VideoInput = {
        notebookId: nb,
        sourceIds,
        format: VIDEO_FORMATS[o.format],
        style: VIDEO_STYLE_KEYS[o.style],
        language: o.language,
        focusPrompt: o.focusPrompt || null,
      };
      if (o.style === "custom") input.stylePrompt = o.stylePrompt;
      return createVideoParams(input);
    });
  }

  async function getStudioStatus(
    accountId: string,
    notebookId: string,
    filter: { artifactId?: string; type?: "audio" | "video" } = {},
  ): Promise<StudioStatusResult> {
    const nb = notebookIdSchema.parse(notebookId);
    const artifactId = filter.artifactId === undefined ? undefined : artifactIdSchema.parse(filter.artifactId);
    const all = await listArtifacts(accountId, nb, "studio_status");
    if (artifactId !== undefined && !all.some((a) => a.id === artifactId)) throw new ArtifactNotFoundError();
    const matching = all
      .filter((a) => (artifactId === undefined || a.id === artifactId) && (filter.type === undefined || typeOf(a) === filter.type))
      .sort((x, y) => (y.createdSec ?? -1) - (x.createdSec ?? -1));
    const rows: StudioRow[] = matching.slice(0, STATUS_PAGE_SIZE).map((a) => {
      const status = studioStatusOf(a);
      return { artifactId: a.id, type: typeOf(a), title: a.title, status, readyMedia: status === "ready" && a.mediaUrl !== null, createdAt: iso(a.createdSec) };
    });
    const running = rows.some((r) => r.status === "queued" || r.status === "generating");
    return { artifacts: rows, total: matching.length, nextCheckInSeconds: running ? NEXT_CHECK_SECONDS : 0 };
  }

  /**
   * Re-lists the notebook and returns the artifact's FRESH media URL (Google URLs expire: never cached, stored or returned to
   * clients). Throws ArtifactNotFound / ArtifactNotDownloadable / ArtifactNotReady.
   */
  async function getMedia(accountId: string, notebookId: string, artifactId: string, tool = "studio_download_link"): Promise<MediaTarget> {
    const nb = notebookIdSchema.parse(notebookId);
    const id = artifactIdSchema.parse(artifactId);
    const a = (await listArtifacts(accountId, nb, tool)).find((x) => x.id === id);
    if (!a) throw new ArtifactNotFoundError();
    const kind = typeOf(a);
    if (kind === "other") throw new ArtifactNotDownloadableError();
    const status = studioStatusOf(a);
    if (status !== "ready" || a.mediaUrl === null || a.mediaMime === null) throw new ArtifactNotReadyError(status);
    return { artifactId: a.id, kind, title: a.title, url: a.mediaUrl, mime: a.mediaMime };
  }

  return { createAudioOverview, createVideoOverview, getStudioStatus, getMedia };
}

export type StudioOps = ReturnType<typeof createStudioOps>;
