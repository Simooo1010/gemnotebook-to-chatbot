import { z } from "zod";

/** PROTOCOL §3 params builders. Every array is copied from the documented shape. Pure. */

const n9 = (): null[] => Array<null>(9).fill(null);

/** Request-options wrapper W = [2,null,null,[1,null×9,[1]]]. */
export const W = (): unknown[] => [2, null, null, [1, ...n9(), [1]]];
/** CREATE/LIST_ARTIFACT options block CA = [2,null,null,[1,null×9,[1]],[[1,4,8,2,3,6]]]. */
export const CA = (): unknown[] => [2, null, null, [1, ...n9(), [1]], [[1, 4, 8, 2, 3, 6]]];

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "invalid id");
const title = z.string().min(1).max(500);
const url = z.string().url().refine((u) => /^https?:\/\//i.test(u), "http(s) only");
const lang = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "invalid language");
const ids = z.array(id).min(1);

export const ARTIFACT_LIST_FILTER = 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"';

// --- notebooks (§3.1) ---
export const listNotebooksParams = (): unknown[] => [null, 1, null, [2]];

export function createNotebookParams(t: string): unknown[] {
  return [title.parse(t), null, null, W()];
}

export function renameNotebookParams(notebookId: string, newTitle: string): unknown[] {
  return [id.parse(notebookId), [[null, null, null, [null, title.parse(newTitle)]]]];
}

export function getNotebookParams(notebookId: string): unknown[] {
  return [id.parse(notebookId), null, W(), null, 0];
}

export function notebookSummaryParams(notebookId: string): unknown[] {
  return [id.parse(notebookId), [2]];
}

// --- sources (§3.2) ---
export function addSourceUrlParams(notebookId: string, u: string): unknown[] {
  return [[[null, null, [url.parse(u)], null, null, null, null, null, null, null, 1]], id.parse(notebookId), W()];
}

/** Fallback ozz5Z; notebook id goes only in source-path. */
export function addSourceUrlFallbackParams(u: string): unknown[] {
  return [[[[null, url.parse(u), 627], [...n9(), [null, null, 1]], 1]]];
}

export const YOUTUBE_RE = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i;

export function addSourceYoutubeParams(notebookId: string, u: string): unknown[] {
  const v = url.refine((x) => YOUTUBE_RE.test(x), "not a YouTube URL").parse(u);
  return [[[null, null, null, null, null, null, null, [v], null, null, 1]], id.parse(notebookId), W()];
}

export function addSourceTextParams(notebookId: string, t: string, content: string): unknown[] {
  const c = z.string().min(1).parse(content);
  return [[[null, [title.parse(t), c], null, 2, null, null, null, null, null, null, 1]], id.parse(notebookId), W()];
}

export const DRIVE_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
  "application/pdf",
] as const;
export type DriveMimeType = (typeof DRIVE_MIME_TYPES)[number];

export function addSourceDriveParams(
  notebookId: string,
  f: { fileId: string; mimeType: DriveMimeType; title: string },
): unknown[] {
  const fileId = id.parse(f.fileId);
  const mime = z.enum(DRIVE_MIME_TYPES).parse(f.mimeType);
  return [
    [[[fileId, mime, 1, title.parse(f.title)], null, null, null, null, null, null, null, null, 1]],
    id.parse(notebookId),
    [2],
    [1, ...n9(), [1]],
  ];
}

export function sourceTextParams(sourceId: string): unknown[] {
  return [[id.parse(sourceId)], [2], [2]];
}

export function sourceGuideParams(sourceId: string): unknown[] {
  return [[[[id.parse(sourceId)]]]];
}

// --- chat (§3.3) ---
export function lastConversationIdParams(notebookId: string): unknown[] {
  return [[], null, id.parse(notebookId), 1];
}

export interface ChatParamsInput {
  notebookId: string;
  sourceIds: string[];
  question: string;
  /** Prior turns, newest first. */
  history?: { question: string; answer: string }[];
  conversationId?: string | null;
}

export function chatParams(i: ChatParamsInput): unknown[] {
  const q = z.string().min(1).max(20000).parse(i.question);
  const hist =
    i.history && i.history.length > 0
      ? i.history.flatMap((t) => [
          [t.answer, null, 2],
          [t.question, null, 1],
        ])
      : null;
  return [
    ids.parse(i.sourceIds).map((s) => [[s]]),
    q,
    hist,
    [2, null, [1], [1]],
    i.conversationId ? id.parse(i.conversationId) : null,
    null,
    null,
    id.parse(i.notebookId),
    1,
  ];
}

// --- studio (§3.4) ---
export const listArtifactsParams = (notebookId: string): unknown[] => [[2], id.parse(notebookId), ARTIFACT_LIST_FILTER];

export enum ArtifactType {
  Audio = 1,
  Report = 2,
  Video = 3,
}
export enum AudioFormat {
  DeepDive = 1,
  Brief = 2,
  Critique = 3,
  Debate = 4,
}
export enum AudioLength {
  Short = 1,
  Default = 2,
  Long = 3,
}
export enum VideoFormat {
  Explainer = 1,
  Brief = 2,
}
/** PY live-captured table (PROTOCOL §3.4). Custom is sent as null + prompt. */
export const VIDEO_STYLES = {
  auto: 1,
  classic: 2,
  whiteboard: 3,
  heritage: 4,
  "paper-craft": 5,
  watercolor: 6,
  anime: 7,
  "retro-print": 8,
  kawaii: 9,
} as const;
export type VideoStyle = keyof typeof VIDEO_STYLES | "custom";

const sourcesTriple = (s: string[]) => s.map((x) => [[x]]);
const ids2 = (s: string[]) => s.map((x) => [x]);

function sparse(len: number, set: Record<number, unknown>): unknown[] {
  const a: unknown[] = Array<unknown>(len).fill(null);
  for (const [k, v] of Object.entries(set)) a[Number(k)] = v;
  return a;
}

const audioSchema = z.object({
  notebookId: id,
  sourceIds: ids,
  format: z.enum(AudioFormat).default(AudioFormat.DeepDive),
  length: z.enum(AudioLength).default(AudioLength.Default),
  language: lang.default("en"),
  focusPrompt: z.string().max(5000).nullish(),
});
export type AudioInput = z.input<typeof audioSchema>;

export function createAudioParams(input: AudioInput): unknown[] {
  const a = audioSchema.parse(input);
  const cfg = [null, [a.focusPrompt || null, a.length, null, ids2(a.sourceIds), a.language, null, a.format]];
  return [CA(), a.notebookId, sparse(7, { 2: ArtifactType.Audio, 3: sourcesTriple(a.sourceIds), 6: cfg })];
}

const videoSchema = z
  .object({
    notebookId: id,
    sourceIds: ids,
    format: z.enum(VideoFormat).default(VideoFormat.Explainer),
    style: z
      .enum(["auto", "classic", "whiteboard", "heritage", "paper-craft", "watercolor", "anime", "retro-print", "kawaii", "custom"] satisfies VideoStyle[])
      .default("auto"),
    stylePrompt: z.string().min(1).max(2000).optional(),
    language: lang.default("en"),
    focusPrompt: z.string().max(5000).nullish(),
  })
  .refine((v) => v.style !== "custom" || !!v.stylePrompt, "custom style needs stylePrompt");
export type VideoInput = z.input<typeof videoSchema>;

export function createVideoParams(input: VideoInput): unknown[] {
  const v = videoSchema.parse(input);
  const inner: unknown[] = [ids2(v.sourceIds), v.language, v.focusPrompt || null, null, v.format];
  if (v.style === "custom") inner.push(null, v.stylePrompt);
  else inner.push(VIDEO_STYLES[v.style]);
  return [CA(), v.notebookId, sparse(9, { 2: ArtifactType.Video, 3: sourcesTriple(v.sourceIds), 8: [null, null, inner] })];
}
