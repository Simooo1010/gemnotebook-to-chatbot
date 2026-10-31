// Typed source operations (SPEC §2, PROTOCOL §3.2). Adds are mutations: never auto-retried; after an ambiguous failure the
// notebook's source list is re-read to reconcile before reporting, so a source is never added twice.
import { z } from "zod";
import type { GoogleClient } from "@/lib/google/client";
import { AmbiguousMutationError, StaleTokenMutationError } from "@/lib/google/errors";
import { resolveRpcId, type RpcName } from "@/lib/rpc/ids";
import {
  DRIVE_MIME_TYPES,
  addSourceDriveParams,
  addSourceTextParams,
  addSourceUrlFallbackParams,
  addSourceUrlParams,
  addSourceYoutubeParams,
  sourceGuideParams,
  sourceTextParams,
  YOUTUBE_RE,
} from "@/lib/rpc/params";
import { RpcDriftError, RpcStatusError } from "@/lib/rpc/errors";
import { decodeAddSource, decodeSourceGuide, decodeSourceText, type Source } from "@/lib/rpc/rows";
import type { CreatedObjects } from "./created";
import type { NotebookOps } from "./notebooks";

export const MAX_URL_CHARS = 2048;
export const MAX_TEXT_TITLE_CHARS = 200;
export const MAX_TEXT_CONTENT_CHARS = 200_000;
/** getSourceText returns at most this many characters. */
export const SOURCE_TEXT_CAP = 60_000;
/** A source counts as "just added" if Google stamped it within this window before our request. */
const RECONCILE_WINDOW_MS = 60_000;

// --- validation ---
export const notebookIdSchema = z.string().uuid();
export const sourceIdSchema = z.string().uuid();

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_CHARS, `URL must be at most ${MAX_URL_CHARS} characters`)
  .superRefine((v, ctx) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "not a valid URL" });
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") ctx.addIssue({ code: "custom", message: "only http(s) URLs are allowed" });
    if (u.username !== "" || u.password !== "") ctx.addIssue({ code: "custom", message: "URLs with credentials are not allowed" });
  });

export const sourceUrlSchema = httpUrl;
export const sourceYoutubeSchema = httpUrl.refine((v) => YOUTUBE_RE.test(v), "must be a youtube.com or youtu.be URL");
export const sourceTextTitleSchema = z.string().trim().min(1).max(MAX_TEXT_TITLE_CHARS);
export const sourceTextContentSchema = z
  .string()
  .max(MAX_TEXT_CONTENT_CHARS, `content must be at most ${MAX_TEXT_CONTENT_CHARS} characters`)
  .refine((v) => v.trim().length > 0, "content must not be empty");
export const driveFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,128}$/, "not a valid Google Drive file id");
export const driveMimeSchema = z.enum(DRIVE_MIME_TYPES);
export const driveTitleSchema = z.string().trim().min(1).max(200);

// --- errors ---
export type SourceStatusName = "processing" | "ready" | "error" | "preparing";

export class SourceNotFoundError extends Error {
  readonly kind = "source_not_found";
  constructor() {
    super("source not found in this notebook");
  }
}

export class SourceNotReadyError extends Error {
  readonly kind = "source_not_ready";
  constructor(readonly status: string) {
    super(`source is not ready (status ${status})`);
  }
}

/** The add failed ambiguously and the source list does not (yet) show it. Never retried automatically. */
export class SourceAddUnconfirmedError extends Error {
  readonly kind = "source_add_unconfirmed";
  constructor(readonly cause: unknown) {
    super("source add was not confirmed: no matching source in the notebook after re-reading it");
  }
}

/** Several sources could be the result: nothing was recorded. */
export class SourceAddAmbiguousError extends Error {
  readonly kind = "source_add_ambiguous";
  constructor(readonly candidateIds: string[]) {
    super(`source add was ambiguous: ${candidateIds.length} sources match`);
  }
}

// --- helpers ---
export interface AddedSource {
  sourceId: string;
  title: string;
  status: SourceStatusName;
  /** True when the add had an unclear outcome and the source was found by re-reading the notebook. */
  reconciled: boolean;
}

export interface SourceText {
  sourceId: string;
  title: string | null;
  text: string;
  truncated: boolean;
  totalChars: number;
}

export interface SourceGuide {
  sourceId: string;
  title: string | null;
  summary: string;
  keywords: string[];
}

/** Which RPC worked for URL adds in this process. */
export interface UrlRpcCache {
  winner: "primary" | "fallback" | null;
}
const processUrlRpcCache: UrlRpcCache = { winner: null };

export interface SourceOpsDeps {
  client: Pick<GoogleClient, "rpc">;
  created: CreatedObjects;
  notebooks: Pick<NotebookOps, "getNotebook">;
  rpcOverridesJson?: string | null;
  now?: () => number;
  urlRpcCache?: UrlRpcCache;
}

const toStatus = (s: Source["status"]): SourceStatusName => (s === "unknown" ? "processing" : s);

function isInvalidArgument(e: unknown): boolean {
  if (e instanceof RpcStatusError) return e.code === 3;
  return e instanceof AmbiguousMutationError && !(e instanceof StaleTokenMutationError) && /INVALID_ARGUMENT/.test(e.reason);
}

/** Outcomes where the write may have happened. */
const isUnclear = (e: unknown): boolean => e instanceof AmbiguousMutationError || e instanceof RpcStatusError || e instanceof RpcDriftError;

function normUrl(v: string): string | null {
  try {
    const u = new URL(v);
    u.hash = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function youtubeKey(v: string): string | null {
  try {
    const u = new URL(v);
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.split("/")[1] || null;
    return u.searchParams.get("v") ?? (/^\/(shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[2] ?? null);
  } catch {
    return null;
  }
}

export function sameUrl(a: string, b: string): boolean {
  const na = normUrl(a);
  if (na !== null && na === normUrl(b)) return true;
  const ya = youtubeKey(a);
  return ya !== null && ya === youtubeKey(b);
}

/** True when the row has no Drive link to compare, or its link carries this file id. */
function driveIdMatches(url: string | null, fileId: string): boolean {
  if (url === null || !/drive\.google\.com|docs\.google\.com/.test(url)) return true;
  return url.includes(fileId);
}

const DRIVE_TYPES = new Set(["google_docs", "google_slides", "google_sheet", "pdf", "drive", "unknown"]);

interface Attempt {
  label: "primary" | "fallback";
  name: RpcName;
  params: unknown;
}

export function createSourceOps(deps: SourceOpsDeps) {
  const now = deps.now ?? Date.now;
  const urlCache = deps.urlRpcCache ?? processUrlRpcCache;
  const rpcId = (n: RpcName) => resolveRpcId(n, deps.rpcOverridesJson);

  async function findSource(accountId: string, notebookId: string, sourceId: string): Promise<Source | null> {
    const nb = await deps.notebooks.getNotebook(accountId, notebookId);
    return nb.sources.find((s) => s.id === sourceId) ?? null;
  }

  async function reconcile(
    accountId: string,
    notebookId: string,
    startedAt: number,
    match: (s: Source) => boolean,
    cause: unknown,
  ): Promise<{ source: Source } | null> {
    let sources: Source[];
    try {
      sources = (await deps.notebooks.getNotebook(accountId, notebookId)).sources;
    } catch {
      throw cause; // could not look: report the original ambiguity
    }
    const known = new Set(await deps.created.list(accountId, "source").catch(() => [] as string[]));
    const candidates = sources.filter(
      (s) =>
        match(s) &&
        !known.has(s.id) &&
        (s.createdSec === null ? s.status !== "ready" : s.createdSec * 1000 >= startedAt - RECONCILE_WINDOW_MS),
    );
    if (candidates.length === 0) return null;
    if (candidates.length > 1) throw new SourceAddAmbiguousError(candidates.map((c) => c.id));
    return { source: candidates[0]! };
  }

  /** Records the id (best effort: the add already happened), then does ONE status read. Never waits. */
  async function finish(
    accountId: string,
    notebookId: string,
    added: { id: string; title: string | null },
    fallbackTitle: string,
    reconciled: boolean,
    known?: Source,
  ): Promise<AddedSource> {
    try {
      await deps.created.record(accountId, "source", added.id);
    } catch (e) {
      console.error("created_objects record failed:", e instanceof Error ? e.name : typeof e);
    }
    let src: Source | null = known ?? null;
    if (!known) {
      try {
        src = await findSource(accountId, notebookId, added.id);
      } catch {
        src = null; // the add succeeded; a failed status read must not look like a failed add
      }
    }
    return {
      sourceId: added.id,
      title: src?.title || added.title || fallbackTitle,
      status: src ? toStatus(src.status) : "processing",
      reconciled,
    };
  }

  async function runAdd(a: {
    accountId: string;
    notebookId: string;
    tool: string;
    attempts: Attempt[];
    match: (s: Source) => boolean;
    fallbackTitle: string;
  }): Promise<AddedSource> {
    const startedAt = now();
    let lastCause: unknown;
    for (let i = 0; i < a.attempts.length; i++) {
      const at = a.attempts[i]!;
      let result: unknown;
      try {
        result = await deps.client.rpc({
          accountId: a.accountId,
          name: at.name,
          params: at.params,
          notebookId: a.notebookId,
          kind: "mutate",
          tool: a.tool,
        });
        const added = decodeAddSource(result, rpcId(at.name));
        if (a.attempts.length > 1) urlCache.winner = at.label;
        return await finish(a.accountId, a.notebookId, added, a.fallbackTitle, false);
      } catch (e) {
        if (!isUnclear(e)) throw e;
        lastCause = e;
        const found = await reconcile(a.accountId, a.notebookId, startedAt, a.match, e);
        if (found) {
          if (a.attempts.length > 1) urlCache.winner = at.label;
          return finish(a.accountId, a.notebookId, { id: found.source.id, title: found.source.title }, a.fallbackTitle, true, found.source);
        }
        // Refused as INVALID_ARGUMENT and nothing was added: only then is the other RPC worth a try.
        if (isInvalidArgument(e) && i < a.attempts.length - 1) continue;
        throw new SourceAddUnconfirmedError(e);
      }
    }
    throw new SourceAddUnconfirmedError(lastCause);
  }

  async function addSourceUrl(accountId: string, notebookId: string, url: string): Promise<AddedSource> {
    const nb = notebookIdSchema.parse(notebookId);
    const u = sourceUrlSchema.parse(url);
    const primary: Attempt = { label: "primary", name: "ADD_SOURCE", params: addSourceUrlParams(nb, u) };
    const fallback: Attempt = { label: "fallback", name: "ADD_SOURCE_URL_FALLBACK", params: addSourceUrlFallbackParams(u) };
    return runAdd({
      accountId,
      notebookId: nb,
      tool: "source_add_url",
      attempts: urlCache.winner === "fallback" ? [fallback, primary] : [primary, fallback],
      match: (s) => s.url !== null && sameUrl(s.url, u),
      fallbackTitle: u,
    });
  }

  async function addSourceYoutube(accountId: string, notebookId: string, url: string): Promise<AddedSource> {
    const nb = notebookIdSchema.parse(notebookId);
    const u = sourceYoutubeSchema.parse(url);
    return runAdd({
      accountId,
      notebookId: nb,
      tool: "source_add_youtube",
      attempts: [{ label: "primary", name: "ADD_SOURCE", params: addSourceYoutubeParams(nb, u) }],
      match: (s) => s.url !== null && sameUrl(s.url, u),
      fallbackTitle: u,
    });
  }

  async function addSourceText(accountId: string, notebookId: string, title: string, content: string): Promise<AddedSource> {
    const nb = notebookIdSchema.parse(notebookId);
    const t = sourceTextTitleSchema.parse(title);
    const c = sourceTextContentSchema.parse(content);
    return runAdd({
      accountId,
      notebookId: nb,
      tool: "source_add_text",
      attempts: [{ label: "primary", name: "ADD_SOURCE", params: addSourceTextParams(nb, t, c) }],
      match: (s) => s.title === t && (s.type === "pasted_text" || s.type === "unknown"),
      fallbackTitle: t,
    });
  }

  async function addSourceDrive(
    accountId: string,
    notebookId: string,
    f: { fileId: string; mimeType: (typeof DRIVE_MIME_TYPES)[number]; title: string },
  ): Promise<AddedSource> {
    const nb = notebookIdSchema.parse(notebookId);
    const file = { fileId: driveFileIdSchema.parse(f.fileId), mimeType: driveMimeSchema.parse(f.mimeType), title: driveTitleSchema.parse(f.title) };
    return runAdd({
      accountId,
      notebookId: nb,
      tool: "source_add_drive",
      attempts: [{ label: "primary", name: "ADD_SOURCE", params: addSourceDriveParams(nb, file) }],
      // Google retitles Drive adds (real capture: sent "VCR Test Drive Doc", stored a Google-derived title), so the
      // title is useless here: match by source type + created time (reconcile's window) and, when the stored row
      // exposes a Drive link, the file id.
      match: (s) => DRIVE_TYPES.has(s.type) && driveIdMatches(s.url, file.fileId),
      fallbackTitle: file.title,
    });
  }

  /** Reads need a ready source: look it up in the notebook first. */
  async function readySource(accountId: string, notebookId: string, sourceId: string): Promise<Source> {
    const src = await findSource(accountId, notebookId, sourceId);
    if (!src) throw new SourceNotFoundError();
    if (src.status !== "ready") throw new SourceNotReadyError(src.status);
    return src;
  }

  async function getSourceText(accountId: string, notebookId: string, sourceId: string): Promise<SourceText> {
    const nb = notebookIdSchema.parse(notebookId);
    const sid = sourceIdSchema.parse(sourceId);
    const src = await readySource(accountId, nb, sid);
    const result = await deps.client.rpc({
      accountId,
      name: "SOURCE_TEXT",
      params: sourceTextParams(sid),
      notebookId: nb,
      kind: "read",
      tool: "source_get_text",
    });
    const d = decodeSourceText(result, rpcId("SOURCE_TEXT"));
    let text = d.text.slice(0, SOURCE_TEXT_CAP);
    if (text.length < d.text.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); // never cut a surrogate pair
    return { sourceId: sid, title: d.title ?? (src.title || null), text, truncated: text.length < d.text.length, totalChars: d.text.length };
  }

  async function getSourceGuide(accountId: string, notebookId: string, sourceId: string): Promise<SourceGuide> {
    const nb = notebookIdSchema.parse(notebookId);
    const sid = sourceIdSchema.parse(sourceId);
    const src = await readySource(accountId, nb, sid);
    const result = await deps.client.rpc({
      accountId,
      name: "SOURCE_GUIDE",
      params: sourceGuideParams(sid),
      notebookId: nb,
      kind: "read",
      tool: "source_get_guide",
    });
    const g = decodeSourceGuide(result, rpcId("SOURCE_GUIDE"));
    return { sourceId: sid, title: src.title || null, summary: g.summary, keywords: g.keywords };
  }

  return { addSourceUrl, addSourceYoutube, addSourceText, addSourceDrive, getSourceText, getSourceGuide };
}

export type SourceOps = ReturnType<typeof createSourceOps>;
