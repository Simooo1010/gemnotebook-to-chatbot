import { RpcDriftError } from "./errors";

/** PROTOCOL §3 row decoders. Errors name only the path, never the data. Pure. */

const fmt = (path: readonly number[]) => path.map((p) => `[${p}]`).join("") || "<root>";

export function optIndex(value: unknown, path: readonly number[]): unknown {
  let cur = value;
  for (const p of path) {
    if (!Array.isArray(cur) || p >= cur.length) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function safeIndex(value: unknown, path: readonly number[], rpcId: string): unknown {
  let cur = value;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    if (!Array.isArray(cur) || p >= cur.length) throw new RpcDriftError(rpcId, [], fmt(path.slice(0, i + 1)));
    cur = cur[p];
  }
  return cur;
}

function str(v: unknown, path: readonly number[], rpcId: string): string {
  const x = safeIndex(v, path, rpcId);
  if (typeof x !== "string") throw new RpcDriftError(rpcId, [], fmt(path));
  return x;
}
const optStr = (v: unknown, p: readonly number[]) => {
  const x = optIndex(v, p);
  return typeof x === "string" ? x : null;
};
const optNum = (v: unknown, p: readonly number[]) => {
  const x = optIndex(v, p);
  return typeof x === "number" ? x : null;
};
function arr(v: unknown, path: readonly number[], rpcId: string): unknown[] {
  const x = safeIndex(v, path, rpcId);
  if (!Array.isArray(x)) throw new RpcDriftError(rpcId, [], fmt(path));
  return x;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Depth-first search for the first UUID string in nested lists. */
export function findUuid(v: unknown, depth = 0): string | null {
  if (typeof v === "string") return UUID_RE.test(v) ? v : null;
  if (!Array.isArray(v) || depth > 12) return null;
  for (const x of v) {
    const r = findUuid(x, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Concatenate all string leaves (depth-first). */
export function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v) && depth < 64) for (const x of v) collectStrings(x, out, depth + 1);
  return out;
}

// --- notebooks ---
export type NotebookRole = "owner" | "editor" | "viewer" | "unknown";
export interface Notebook {
  id: string;
  title: string;
  emoji: string | null;
  role: NotebookRole;
  lastViewedSec: number | null;
  createdSec: number | null;
}

const ROLES: Record<number, NotebookRole> = { 1: "owner", 2: "editor", 3: "viewer" };

export function decodeNotebookRow(row: unknown, rpcId: string): Notebook {
  const t = str(row, [0], rpcId);
  return {
    id: str(row, [2], rpcId),
    title: t.startsWith("thought\n") ? t.slice("thought\n".length) : t,
    emoji: optStr(row, [3]),
    role: ROLES[optNum(row, [5, 0]) ?? 0] ?? "unknown",
    lastViewedSec: optNum(row, [5, 5, 0]),
    createdSec: optNum(row, [5, 8, 0]),
  };
}

export function decodeNotebookList(result: unknown, rpcId: string): Notebook[] {
  if (optIndex(result, [0]) === null) return [];
  return arr(result, [0], rpcId).map((r) => decodeNotebookRow(r, rpcId));
}

export function decodeCreateNotebook(result: unknown, rpcId: string): { id: string } {
  return { id: str(result, [2], rpcId) };
}

// --- sources ---
export type SourceStatus = "unknown" | "processing" | "ready" | "error" | "preparing";
const SOURCE_STATUS: Record<number, SourceStatus> = { 1: "processing", 2: "ready", 3: "error", 5: "preparing" };

export const SOURCE_TYPES: Record<number, string> = {
  1: "google_docs",
  2: "google_slides",
  3: "pdf",
  4: "pasted_text",
  5: "web_page",
  6: "pptx",
  7: "google_sheet",
  8: "markdown",
  9: "youtube",
  10: "media",
  11: "docx",
  13: "image",
  14: "drive",
  16: "csv",
  17: "epub",
  18: "gemini_chat",
  20: "play_books",
};

export interface Source {
  id: string;
  title: string;
  typeCode: number | null;
  type: string;
  status: SourceStatus;
  url: string | null;
  wordCount: number | null;
  createdSec: number | null;
}

export function decodeSourceRow(row: unknown, rpcId: string): Source {
  const sid = findUuid(safeIndex(row, [0], rpcId));
  if (!sid) throw new RpcDriftError(rpcId, [], "[0]<uuid>");
  const typeCode = optNum(row, [2, 4]);
  return {
    id: sid,
    title: optStr(row, [1]) ?? "",
    typeCode,
    type: typeCode === null ? "unknown" : (SOURCE_TYPES[typeCode] ?? "unknown"),
    status: SOURCE_STATUS[optNum(row, [3, 1]) ?? -1] ?? "unknown",
    url: optStr(row, [2, 7, 0]) ?? optStr(row, [2, 5, 0]),
    wordCount: optNum(row, [2, 1]),
    createdSec: optNum(row, [2, 2, 0]),
  };
}

export interface NotebookDetail extends Notebook {
  sources: Source[];
}

export function decodeGetNotebook(result: unknown, rpcId: string): NotebookDetail {
  const row = safeIndex(result, [0], rpcId);
  const srcs = optIndex(row, [1]);
  return {
    ...decodeNotebookRow(row, rpcId),
    sources: Array.isArray(srcs) ? srcs.map((s) => decodeSourceRow(s, rpcId)) : [],
  };
}

export function decodeAddSource(result: unknown, rpcId: string): { id: string; title: string | null } {
  const row = safeIndex(result, [0, 0], rpcId);
  const sid = findUuid(safeIndex(row, [0], rpcId));
  if (!sid) throw new RpcDriftError(rpcId, [], "[0][0][0]<uuid>");
  return { id: sid, title: optStr(row, [1]) };
}

export function decodeNotebookSummary(
  result: unknown,
  rpcId: string,
): { summary: string; suggestedQuestions: { question: string; prompt: string | null }[] } | null {
  if (result === null) return null;
  const qs = optIndex(result, [0, 1, 0]);
  return {
    summary: str(result, [0, 0, 0], rpcId),
    suggestedQuestions: Array.isArray(qs)
      ? qs.filter(Array.isArray).map((q) => ({ question: optStr(q, [0]) ?? "", prompt: optStr(q, [1]) }))
      : [],
  };
}

export function decodeSourceGuide(result: unknown, rpcId: string): { summary: string; keywords: string[] } {
  const kw = optIndex(result, [0, 0, 2, 0]);
  return {
    summary: str(result, [0, 0, 1, 0], rpcId),
    keywords: Array.isArray(kw) ? kw.filter((k): k is string => typeof k === "string") : [],
  };
}

export function decodeSourceText(result: unknown, rpcId: string): { title: string | null; text: string } {
  const tree = safeIndex(result, [3, 0], rpcId);
  return { title: optStr(result, [0, 1]), text: collectStrings(tree).join("") };
}

export function decodeLastConversationId(result: unknown, rpcId: string): string | null {
  if (result === null) return null;
  const v = optIndex(result, [0, 0, 0]);
  if (v === undefined) throw new RpcDriftError(rpcId, [], "[0][0][0]");
  return typeof v === "string" ? v : null;
}

// --- artifacts ---
export type ArtifactState = "pending" | "ready" | "failed" | "unknown";
export interface Artifact {
  id: string;
  title: string | null;
  typeCode: number | null;
  statusCode: number | null;
  state: ArtifactState;
  mediaUrl: string | null;
  mediaMime: string | null;
  /** Creation time, `row[15][0]` (seconds). Null when Google omits it. */
  createdSec: number | null;
}

type Media = { url: string; kind: number | null; mime: string | null };
function mediaList(v: unknown): Media[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(Array.isArray)
    .map((m) => ({ url: optStr(m, [0]) ?? "", kind: optNum(m, [1]), mime: optStr(m, [2]) }))
    .filter((m) => m.url !== "");
}

export function artifactMedia(row: unknown, typeCode: number | null): Media | null {
  if (typeCode === 1) return mediaList(optIndex(row, [6, 5])).find((m) => m.mime === "audio/mp4") ?? null;
  if (typeCode === 3)
    return mediaList(optIndex(row, [8, 4])).find((m) => m.kind === 4 && m.mime === "video/mp4") ?? null;
  return null;
}

export function artifactState(statusCode: number | null, typeCode: number | null, hasMedia: boolean): ArtifactState {
  if (statusCode === 1 || statusCode === 2) return "pending";
  if (statusCode === 4) return "failed";
  if (statusCode === 3) {
    const needsMedia = typeCode === 1 || typeCode === 3;
    return needsMedia && !hasMedia ? "pending" : "ready";
  }
  return "unknown";
}

export function decodeArtifactRow(row: unknown, rpcId: string): Artifact {
  const typeCode = optNum(row, [2]);
  const statusCode = optNum(row, [4]);
  const media = artifactMedia(row, typeCode);
  return {
    id: str(row, [0], rpcId),
    title: optStr(row, [1]),
    typeCode,
    statusCode,
    state: artifactState(statusCode, typeCode, media !== null),
    mediaUrl: media?.url ?? null,
    mediaMime: media?.mime ?? null,
    createdSec: optNum(row, [15, 0]),
  };
}

export function decodeArtifactList(result: unknown, rpcId: string): Artifact[] {
  if (result === null) return [];
  const rows = optIndex(result, [0]);
  if (rows === null) return [];
  const list = arr(result, [0], rpcId);
  // "result[0] = rows (or a flat list)": a flat list means result[0] is itself a row.
  const isFlat = typeof list[0] === "string";
  return (isFlat ? [list] : list).map((r) => decodeArtifactRow(r, rpcId));
}

export function decodeCreateArtifact(result: unknown, rpcId: string): { id: string; statusCode: number | null } {
  return { id: str(result, [0, 0], rpcId), statusCode: optNum(result, [0, 4]) };
}
