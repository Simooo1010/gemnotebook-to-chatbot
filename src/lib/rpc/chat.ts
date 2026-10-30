import { parseEnvelopes } from "./decode";
import { RpcAuthError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "./errors";
import { collectStrings, findUuid, optIndex } from "./rows";

/** PROTOCOL §3.3 streamed chat response parsing. Pure. */

export const CHAT_RPC_LABEL = "GenerateFreeFormStreamed";

export interface Citation {
  /** 1-based raw position in the citation list; matches [N] markers. */
  index: number;
  chunkId: string | null;
  sourceId: string | null;
  score: number | null;
  range: { start: number; end: number } | null;
  text: string;
}

export interface ChatAnswer {
  text: string;
  isFinal: boolean;
  citations: Citation[];
  /** Distinct citation numbers referenced by [N] markers in the text, in order of appearance. */
  markers: number[];
  suggestedQuestions: string[];
}

interface Chunk {
  inner: unknown[];
  text: string;
  isFinal: boolean;
}

function decodeCitation(cite: unknown, index: number): Citation {
  const s = optIndex(cite, [1, 3, 0, 1]);
  const e = optIndex(cite, [1, 3, 0, 2]);
  const chunkId = optIndex(cite, [0, 0]);
  const score = optIndex(cite, [1, 2]);
  return {
    index,
    chunkId: typeof chunkId === "string" ? chunkId : null,
    sourceId: findUuid(optIndex(cite, [1, 5])),
    score: typeof score === "number" ? score : null,
    range: typeof s === "number" && typeof e === "number" ? { start: s, end: e } : null,
    text: collectStrings(optIndex(cite, [1, 4, 0])).join(""),
  };
}

export function extractMarkers(text: string): number[] {
  const seen: number[] = [];
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1]!.split(",")) {
      const v = Number.parseInt(n.trim(), 10);
      if (v > 0 && !seen.includes(v)) seen.push(v);
    }
  }
  return seen;
}

export function parseChatResponse(text: string): ChatAnswer {
  const envs = parseEnvelopes(text);
  const chunks: Chunk[] = [];
  let status: unknown = null;
  for (const e of envs) {
    if (e[0] !== "wrb.fr") continue;
    if (typeof e[2] !== "string") {
      if (Array.isArray(e[5])) status = e[5];
      continue;
    }
    let inner: unknown;
    try {
      inner = JSON.parse(e[2]);
    } catch {
      continue;
    }
    if (!Array.isArray(inner)) continue;
    const row = inner[0];
    const t = optIndex(row, [0]);
    if (typeof t !== "string" || t === "") continue;
    const doc = optIndex(row, [4]);
    // Last element of TailwindDoc == 1 marks an answer chunk; otherwise thinking text.
    if (Array.isArray(doc) && doc.length > 0 && doc[doc.length - 1] !== 1) continue;
    chunks.push({ inner, text: t, isFinal: inner[4] === true });
  }

  if (chunks.length === 0) {
    if (Array.isArray(status)) {
      const code = status[0];
      if (code === 16) throw new RpcAuthError(CHAT_RPC_LABEL, "grpc_16");
      if (code === 8 || collectStrings(status).some((s) => s.includes("UserDisplayableError")))
        throw new RpcQuotaError(CHAT_RPC_LABEL, code === 8 ? "grpc_8" : "user_displayable");
      throw new RpcStatusError(CHAT_RPC_LABEL, typeof code === "number" ? code : -1);
    }
    if (envs.some((e) => e[0] === "e")) throw new RpcQuotaError(CHAT_RPC_LABEL, "chat_exhausted");
    throw new RpcNoFramesError(CHAT_RPC_LABEL);
  }

  // Chunks are cumulative: pick the final one, else the longest. Never concatenate.
  const pick =
    [...chunks].reverse().find((c) => c.isFinal) ??
    chunks.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  const list = optIndex(pick.inner, [0, 4, 3]);
  const citations = Array.isArray(list) ? list.map((c, i) => decodeCitation(c, i + 1)) : [];
  const sq = optIndex(pick.inner, [5, 0]);
  return {
    text: pick.text,
    isFinal: pick.isFinal,
    citations,
    markers: extractMarkers(pick.text),
    suggestedQuestions: Array.isArray(sq)
      ? sq.map((q) => (typeof q === "string" ? q : (collectStrings(q)[0] ?? ""))).filter(Boolean)
      : [],
  };
}
