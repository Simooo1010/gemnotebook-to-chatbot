// Chat operation: ask a notebook a question and get an answer with citations (SPEC §2 chat row, PROTOCOL §3.3).
//
// Conversation behaviour (documented choice, UNVERIFIED live):
//  - First turn: conversationId = null in the request, which PROTOCOL §3.3 defines as "the server uses the notebook's
//    current conversation, creating one". After the turn we resolve the id with GET_LAST_CONVERSATION_ID (hPTbtc, a read)
//    and return it so Claude can continue the thread. If that read fails the answer is still returned (without an id).
//  - Follow-up: Claude passes conversationId back. We send it as the request's conversationId and history = null: this
//    server keeps NO transcript (nothing about chats is stored), so the history array cannot be rebuilt from data we hold;
//    the server-side conversation carries the context. The supplied id is returned unchanged (no extra read).
//  - newThread is NOT supported: PROTOCOL gives no way to force a new server-side conversation (null = reuse the current
//    one), so it is rejected with ChatNewThreadUnsupportedError rather than guessed.
// A chat turn is a mutation: never auto-retried. The question and answer are never logged or stored.
import { z } from "zod";
import type { GoogleClient } from "@/lib/google/client";
import { AmbiguousMutationError } from "@/lib/google/errors";
import { parseChatResponse, type Citation } from "@/lib/rpc/chat";
import { resolveRpcId } from "@/lib/rpc/ids";
import { chatParams, lastConversationIdParams } from "@/lib/rpc/params";
import { decodeLastConversationId } from "@/lib/rpc/rows";
import { NotEnoughReadySourcesError } from "./studio";
import type { NotebookOps } from "./notebooks";

export const MAX_QUESTION_CHARS = 4000;
export const MAX_CHAT_SOURCE_IDS = 300;
/** Size caps for the returned result (the tool adds a larger overall result cap). Nothing is cut silently: flags say so. */
export const MAX_ANSWER_CHARS = 10_000;
export const MAX_CITATIONS = 20;
export const MAX_EXCERPT_CHARS = 400;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUGGESTED_QUESTIONS = 5;
export const MAX_SUGGESTED_CHARS = 150;

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const conversationIdSchema = z.string().regex(idPattern, "invalid conversation id");
export const questionSchema = z.string().trim().min(1).max(MAX_QUESTION_CHARS);

export const askOptionsSchema = z.object({
  question: questionSchema,
  sourceIds: z.array(z.string().uuid()).min(1).max(MAX_CHAT_SOURCE_IDS).optional(),
  conversationId: conversationIdSchema.optional(),
  newThread: z.boolean().optional(),
});
export type AskOptions = z.input<typeof askOptionsSchema>;

/** newThread was requested but the protocol offers no way to start a fresh server-side conversation. */
export class ChatNewThreadUnsupportedError extends Error {
  readonly kind = "chat_new_thread_unsupported";
  constructor() {
    super("starting a fresh conversation is not supported yet");
  }
}

/** The chat request failed in an unclear way: the turn may or may not have been recorded. Never retried automatically. */
export class ChatTurnUnconfirmedError extends Error {
  readonly kind = "chat_turn_unconfirmed";
  constructor(readonly cause: unknown) {
    super("the chat request was not confirmed");
  }
}

export interface ChatCitation {
  /** Matches the [N] marker in the answer. */
  n: number;
  /** Null when the response gave no readable source id. */
  sourceId: string | null;
  /** Undefined when the source id is not in the notebook's source list (kept, not dropped). */
  sourceTitle?: string;
  excerpt: string;
  score?: number;
}

export interface ChatResult {
  /** Answer text with [N] citation markers. */
  answer: string;
  answerTruncated: boolean;
  citations: ChatCitation[];
  /** Citations left out only because of the size cap. */
  citationsOmitted: number;
  suggestedQuestions?: string[];
  conversationId?: string;
  sourcesUsed: number;
}

const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export interface ChatOpsDeps {
  client: Pick<GoogleClient, "rpc" | "chatStream">;
  notebooks: Pick<NotebookOps, "getNotebook">;
  rpcOverridesJson?: string | null;
}

export function createChatOps(deps: ChatOpsDeps) {
  async function askNotebook(accountId: string, notebookId: string, opts: AskOptions): Promise<ChatResult> {
    const nb = z.string().uuid().parse(notebookId);
    const o = askOptionsSchema.parse(opts);
    if (o.newThread) throw new ChatNewThreadUnsupportedError();

    // Pre-flight read (not counted against the chat cap): which sources can be used.
    const detail = await deps.notebooks.getNotebook(accountId, nb);
    const counts = { total: detail.sources.length, ready: detail.sources.filter((s) => s.status === "ready").length };
    if (counts.total === 0) throw new NotEnoughReadySourcesError("no_sources", counts);
    let sourceIds: string[];
    if (o.sourceIds) {
      const byId = new Map(detail.sources.map((s) => [s.id, s]));
      sourceIds = [...new Set(o.sourceIds)];
      for (const id of sourceIds) if (!byId.has(id)) throw new NotEnoughReadySourcesError("selected_unknown", counts);
      for (const id of sourceIds) if (byId.get(id)!.status !== "ready") throw new NotEnoughReadySourcesError("selected_not_ready", counts);
    } else {
      sourceIds = detail.sources.filter((s) => s.status === "ready").map((s) => s.id);
      if (sourceIds.length === 0) throw new NotEnoughReadySourcesError("none_ready", counts);
    }

    const params = chatParams({ notebookId: nb, sourceIds, question: o.question, history: undefined, conversationId: o.conversationId ?? null });
    let raw: string;
    try {
      raw = (await deps.client.chatStream({ accountId, notebookId: nb, params, usageKind: "chat", tool: "chat_ask" })).text;
    } catch (e) {
      // Unclear outcome (timeout, 5xx, stale token): the turn may exist. Quota, daily cap, cooldown, auth, size: as they are.
      if (e instanceof AmbiguousMutationError) throw new ChatTurnUnconfirmedError(e);
      throw e;
    }
    const parsed = parseChatResponse(raw); // cumulative chunk selection; quota-exhausted stream -> RpcQuotaError

    let conversationId: string | undefined = o.conversationId;
    if (conversationId === undefined) {
      try {
        const r = await deps.client.rpc({
          accountId,
          name: "GET_LAST_CONVERSATION_ID",
          params: lastConversationIdParams(nb),
          notebookId: nb,
          kind: "read",
          tool: "chat_ask",
        });
        const id = decodeLastConversationId(r, resolveRpcId("GET_LAST_CONVERSATION_ID", deps.rpcOverridesJson));
        if (id !== null && idPattern.test(id)) conversationId = id;
      } catch {
        // The answer exists already; a failed id lookup only means Claude cannot continue the thread explicitly.
      }
    }

    const titles = new Map(detail.sources.map((s) => [s.id, s.title]));
    const marked = new Set(parsed.markers);
    const toCitation = (c: Citation): ChatCitation => {
      const title = c.sourceId === null ? undefined : titles.get(c.sourceId);
      return {
        n: c.index,
        sourceId: c.sourceId,
        ...(title !== undefined ? { sourceTitle: cut(title, MAX_TITLE_CHARS) } : {}),
        excerpt: cut(c.text.trim(), MAX_EXCERPT_CHARS),
        ...(c.score !== null ? { score: c.score } : {}),
      };
    };
    // Cited ones first when the list has to be cut, then back in marker order.
    const ranked = [...parsed.citations].sort((a, b) => Number(marked.has(b.index)) - Number(marked.has(a.index)) || a.index - b.index);
    const kept = ranked.slice(0, MAX_CITATIONS).sort((a, b) => a.index - b.index);
    const suggested = parsed.suggestedQuestions.slice(0, MAX_SUGGESTED_QUESTIONS).map((q) => cut(q, MAX_SUGGESTED_CHARS));

    return {
      answer: cut(parsed.text, MAX_ANSWER_CHARS),
      answerTruncated: parsed.text.length > MAX_ANSWER_CHARS,
      citations: kept.map(toCitation),
      citationsOmitted: parsed.citations.length - kept.length,
      ...(suggested.length > 0 ? { suggestedQuestions: suggested } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      sourcesUsed: sourceIds.length,
    };
  }

  return { askNotebook };
}

export type ChatOps = ReturnType<typeof createChatOps>;
