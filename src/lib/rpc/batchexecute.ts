import { BATCH_PATH, CHAT_STREAM_PATH } from "./ids";

/** PROTOCOL §2.1 / §2.3 request encoding. Pure. */

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

export interface BatchUrlInput {
  base: string;
  rpcId: string;
  sourcePath: string;
  fsid: string;
  bl?: string;
  authuser?: string | number;
  hl?: string;
}

export function buildBatchUrl(i: BatchUrlInput): string {
  const q = new URLSearchParams();
  q.set("rpcids", i.rpcId);
  q.set("source-path", i.sourcePath);
  q.set("f.sid", i.fsid);
  q.set("hl", i.hl ?? "en");
  q.set("rt", "c");
  if (i.bl) q.set("bl", i.bl);
  if (i.authuser !== undefined && i.authuser !== "") q.set("authuser", String(i.authuser));
  return `${trimBase(i.base)}${BATCH_PATH}?${q.toString()}`;
}

export function encodeBatchBody(i: { rpcId: string; params: unknown; at: string }): string {
  const freq = JSON.stringify([[[i.rpcId, JSON.stringify(i.params), null, "generic"]]]);
  return `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(i.at)}&`;
}

export interface ChatUrlInput {
  base: string;
  bl: string;
  reqId: number;
  fsid?: string;
  authuser?: string | number;
  hl?: string;
}

export function buildChatUrl(i: ChatUrlInput): string {
  const q = new URLSearchParams();
  q.set("bl", i.bl);
  q.set("hl", i.hl ?? "en");
  q.set("_reqid", String(i.reqId));
  q.set("rt", "c");
  if (i.fsid) q.set("f.sid", i.fsid);
  if (i.authuser !== undefined && i.authuser !== "") q.set("authuser", String(i.authuser));
  return `${trimBase(i.base)}${CHAT_STREAM_PATH}?${q.toString()}`;
}

export function encodeChatBody(i: { params: unknown; at: string }): string {
  const freq = JSON.stringify([null, JSON.stringify(i.params)]);
  return `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(i.at)}&`;
}

export const REQID_BASE = 100000;
export const REQID_STEP = 100000;

/** Monotonic _reqid (PY: baseline 100000, +100000 per request). */
export function nextReqId(prev?: number): number {
  return prev === undefined ? REQID_BASE : prev + REQID_STEP;
}
