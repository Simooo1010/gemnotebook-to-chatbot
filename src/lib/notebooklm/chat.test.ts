// Fixtures are SYNTHETIC (built from docs/PROTOCOL.md §3.3); replace with real captures in the real-data run.
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createGoogleClient, type AuditRow, type ChatStreamCall, type RpcCall } from "@/lib/google/client";
import { AmbiguousMutationError, ChatResponseTooLargeError, DailyCapReachedError } from "@/lib/google/errors";
import { MemoryUsageCounter, createThrottle } from "@/lib/google/throttle";
import { batchBody, fakeClock, homepageHtml, res, scriptedFetch, synthJar, type Handler } from "@/lib/google/testing";
import { RpcQuotaError } from "@/lib/rpc/errors";
import type { NotebookDetail, Source } from "@/lib/rpc/rows";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";
import {
  ChatNewThreadUnsupportedError,
  ChatTurnUnconfirmedError,
  MAX_ANSWER_CHARS,
  MAX_CITATIONS,
  MAX_EXCERPT_CHARS,
  createChatOps,
} from "./chat";
import { NotEnoughReadySourcesError } from "./studio";

const N = null;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ACC = "acc-1";
const NB = uuid(1);
const S1 = uuid(11);
const S2 = uuid(12);
const S3 = uuid(13);
const GHOST = uuid(99);
const CONV = "11111111-2222-4333-8444-555555555555";
const QUESTION = "SYNTHETIC_QUESTION_TEXT_q1";
const ANSWER = "SYNTHETIC_ANSWER_TEXT_a1";

const src = (id: string, status: Source["status"], title = `Title ${id.slice(-2)}`): Source => ({ id, title, typeCode: 5, type: "web_page", status, url: N, wordCount: N, createdSec: N });
const nb = (...sources: Source[]) => ({ id: NB, title: "T", sources }) as unknown as NotebookDetail;

const cite = (chunk: string, source: string | null, text: string, score = 0.5) => [[chunk], [N, N, score, [[N, 0, 10]], [[text]], source ? [[[source]]] : N]];
function chunk(text: string, o: { cites?: unknown[]; final?: boolean; thinking?: boolean; suggested?: string[] } = {}) {
  const doc = [N, N, N, o.cites ?? [], o.thinking ? 0 : 1];
  const inner = [[text, N, ["sess", "turn"], N, doc], N, N, N, o.final ?? false, [(o.suggested ?? []).map((q) => [q])]];
  return ["wrb.fr", N, JSON.stringify(inner)];
}
const frames = (...fs: unknown[]) => {
  const line = JSON.stringify(fs);
  return `)]}'\n\n${line.length}\n${line}\n`;
};

/** Scripted client: chatStream returns / throws the given outcome; rpc answers hPTbtc. */
function setup(sources: Source[], body: string | Error, conv: unknown = [[[CONV]]]) {
  const chatCalls: ChatStreamCall[] = [];
  const rpcCalls: RpcCall[] = [];
  const client = {
    async chatStream(c: ChatStreamCall) {
      chatCalls.push(c);
      if (body instanceof Error) throw body;
      return { text: body, reqId: 1 };
    },
    async rpc(c: RpcCall) {
      rpcCalls.push(c);
      if (conv instanceof Error) throw conv;
      return conv;
    },
  };
  const getNotebook = vi.fn(async () => nb(...sources));
  const ops = createChatOps({ client, notebooks: { getNotebook } });
  return { ops, chatCalls, rpcCalls, getNotebook };
}

const twoChunks = frames(
  chunk("Thinking about it", { thinking: true }),
  chunk("Cats sleep [1]", { cites: [cite("c1", S1, "Cats sleep a lot.")] }),
  chunk("Cats sleep a lot [1][2] and nap [3].", {
    cites: [cite("c1", S1, "Cats sleep a lot.", 0.9), cite("c2", S2, "Naps are short."), cite("c3", GHOST, "From elsewhere.")],
    final: true,
    suggested: ["Why?", "How long?"],
  }),
);

describe("askNotebook", () => {
  it("picks the cumulative final chunk, maps citations to titles, keeps unknown sources, resolves the conversation id", async () => {
    const s = setup([src(S1, "ready", "Cat book"), src(S2, "ready", "Nap paper"), src(S3, "processing")], twoChunks);
    const r = await s.ops.askNotebook(ACC, NB, { question: `  ${QUESTION} ` });
    expect(r.answer).toBe("Cats sleep a lot [1][2] and nap [3].");
    expect(r.citations).toEqual([
      { n: 1, sourceId: S1, sourceTitle: "Cat book", excerpt: "Cats sleep a lot.", score: 0.9 },
      { n: 2, sourceId: S2, sourceTitle: "Nap paper", excerpt: "Naps are short.", score: 0.5 },
      { n: 3, sourceId: GHOST, excerpt: "From elsewhere.", score: 0.5 }, // unknown source: kept, no title
    ]);
    expect(r.citations[2]).not.toHaveProperty("sourceTitle");
    expect(r.suggestedQuestions).toEqual(["Why?", "How long?"]);
    expect(r.conversationId).toBe(CONV);
    expect(r.answerTruncated).toBe(false);
    expect(r.citationsOmitted).toBe(0);
    expect(r.sourcesUsed).toBe(2);
    // request: only READY sources, double wrapped, trimmed question, no history, no conversation id, chat usage kind
    expect(s.chatCalls).toHaveLength(1);
    expect(s.chatCalls[0]).toMatchObject({ accountId: ACC, notebookId: NB, usageKind: "chat", tool: "chat_ask" });
    expect(s.chatCalls[0]!.params).toEqual([[[[S1]], [[S2]]], QUESTION, N, [2, N, [1], [1]], N, N, N, NB, 1]);
    expect(s.rpcCalls).toHaveLength(1);
    expect(s.rpcCalls[0]).toMatchObject({ name: "GET_LAST_CONVERSATION_ID", kind: "read", params: [[], N, NB, 1] });
  });

  it("a citation without a readable source id is kept with sourceId null", async () => {
    const body = frames(chunk("Hi [1]", { cites: [cite("c1", null, "x")], final: true }));
    const r = await setup([src(S1, "ready")], body).ops.askNotebook(ACC, NB, { question: "q" });
    expect(r.citations).toEqual([{ n: 1, sourceId: null, excerpt: "x", score: 0.5 }]);
  });

  it("explicit sourceIds are used as given (deduplicated)", async () => {
    const s = setup([src(S1, "ready"), src(S2, "ready")], twoChunks);
    const r = await s.ops.askNotebook(ACC, NB, { question: "q", sourceIds: [S2, S2] });
    expect((s.chatCalls[0]!.params as unknown[])[0]).toEqual([[[S2]]]);
    expect(r.sourcesUsed).toBe(1);
  });

  it.each([
    ["no sources", [], undefined, "no_sources"],
    ["none ready", [src(S1, "processing")], undefined, "none_ready"],
    ["unknown selected", [src(S1, "ready")], [GHOST], "selected_unknown"],
    ["selected not ready", [src(S1, "ready"), src(S2, "processing")], [S2], "selected_not_ready"],
  ] as const)("pre-flight refusal (%s): typed error, nothing sent", async (_n, sources, sourceIds, reason) => {
    const s = setup([...sources], twoChunks);
    const err = await s.ops.askNotebook(ACC, NB, { question: "q", sourceIds: sourceIds ? [...sourceIds] : undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(NotEnoughReadySourcesError);
    expect((err as NotEnoughReadySourcesError).reason).toBe(reason);
    expect(s.chatCalls).toHaveLength(0);
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("follow-up sends the supplied conversation id, no history, no extra id lookup, returns the same id", async () => {
    const s = setup([src(S1, "ready")], twoChunks);
    const r = await s.ops.askNotebook(ACC, NB, { question: "and then?", conversationId: CONV });
    expect((s.chatCalls[0]!.params as unknown[]).slice(0, 5)).toEqual([[[[S1]]], "and then?", N, [2, N, [1], [1]], CONV]);
    expect(s.rpcCalls).toHaveLength(0);
    expect(r.conversationId).toBe(CONV);
  });

  it("newThread is rejected before any call", async () => {
    const s = setup([src(S1, "ready")], twoChunks);
    await expect(s.ops.askNotebook(ACC, NB, { question: "q", newThread: true })).rejects.toBeInstanceOf(ChatNewThreadUnsupportedError);
    expect(s.getNotebook).not.toHaveBeenCalled();
    expect(s.chatCalls).toHaveLength(0);
  });

  it("a failed conversation-id lookup does not lose the answer", async () => {
    const s = setup([src(S1, "ready")], twoChunks, new Error("boom"));
    const r = await s.ops.askNotebook(ACC, NB, { question: "q" });
    expect(r.answer).toContain("Cats sleep");
    expect(r).not.toHaveProperty("conversationId");
  });

  it("an unreadable conversation id (null) means no conversationId", async () => {
    const r = await setup([src(S1, "ready")], twoChunks, N).ops.askNotebook(ACC, NB, { question: "q" });
    expect(r).not.toHaveProperty("conversationId");
  });

  it("quota-exhausted stream (no payload frame) -> RpcQuotaError, no id lookup", async () => {
    const s = setup([src(S1, "ready")], frames(["di", 5], ["e", 4, N, N, 0]));
    await expect(s.ops.askNotebook(ACC, NB, { question: "q" })).rejects.toBeInstanceOf(RpcQuotaError);
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("ambiguous transport failure -> ChatTurnUnconfirmedError; other errors pass through", async () => {
    const amb = setup([src(S1, "ready")], new AmbiguousMutationError("GenerateFreeFormStreamed", "timeout"));
    await expect(amb.ops.askNotebook(ACC, NB, { question: "q" })).rejects.toBeInstanceOf(ChatTurnUnconfirmedError);
    const big = setup([src(S1, "ready")], new ChatResponseTooLargeError(10));
    await expect(big.ops.askNotebook(ACC, NB, { question: "q" })).rejects.toBeInstanceOf(ChatResponseTooLargeError);
    const cap = setup([src(S1, "ready")], new DailyCapReachedError(ACC, "chat", 30));
    await expect(cap.ops.askNotebook(ACC, NB, { question: "q" })).rejects.toBeInstanceOf(DailyCapReachedError);
  });

  it("caps the answer, the excerpts and the citation list, and says so", async () => {
    const many = Array.from({ length: 30 }, (_, i) => cite(`c${i}`, S1, "e".repeat(1000)));
    const longText = `${"x".repeat(MAX_ANSWER_CHARS + 500)} [30] [29]`;
    const body = frames(chunk(longText, { cites: many, final: true }));
    const r = await setup([src(S1, "ready")], body).ops.askNotebook(ACC, NB, { question: "q" });
    expect(r.answer.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    expect(r.answerTruncated).toBe(true);
    expect(r.citations).toHaveLength(MAX_CITATIONS);
    expect(r.citationsOmitted).toBe(30 - MAX_CITATIONS);
    for (const c of r.citations) expect(c.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    // citations that the text marks are kept first when cutting; the list stays ordered by n
    expect(r.citations.map((c) => c.n).slice(-2)).toEqual([29, 30]);
    expect(r.citations.map((c) => c.n)).toEqual([...r.citations.map((c) => c.n)].sort((a, b) => a - b));
  });

  it("validates the question (1 to 4000 characters) and ids", async () => {
    const s = setup([src(S1, "ready")], twoChunks);
    await expect(s.ops.askNotebook(ACC, NB, { question: "   " })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.askNotebook(ACC, NB, { question: "q".repeat(4001) })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.askNotebook(ACC, NB, { question: "q".repeat(4000) })).resolves.toBeDefined();
    await expect(s.ops.askNotebook(ACC, "not-a-uuid", { question: "q" })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.askNotebook(ACC, NB, { question: "q", conversationId: "bad id!" })).rejects.toBeInstanceOf(ZodError);
    await expect(s.ops.askNotebook(ACC, NB, { question: "q", sourceIds: ["nope"] })).rejects.toBeInstanceOf(ZodError);
  });
});

// --- with the real client: daily chat cap, never retried, audit rows carry no question/answer ---
const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), VAULT_KEY_VERSION: "1" });
const rotateOk: Handler = () => res(200, { setCookie: ["SIDCC=SYNTHETIC_SIDCC_x3; Domain=.google.com; Path=/; Secure"] });
const home: Handler = () => res(200, { body: homepageHtml() });

async function realSetup(handlers: Handler[], caps?: { chat: number }) {
  const clock = fakeClock();
  const accounts = new MemoryAccountRepo();
  const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
  const { account } = await vault.connectAccount("Synthetic", synthJar().cookies);
  const { fetch, calls } = scriptedFetch(handlers);
  const audit: AuditRow[] = [];
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep, backoffBaseMs: 1000, usage: new MemoryUsageCounter(), caps });
  const client = createGoogleClient({ fetch, vault, accounts, throttle, audit: { write: async (r) => void audit.push(r) }, config: { base: "https://notebook.google.com" }, now: clock.now });
  const getNotebook = async () => nb(src(S1, "ready"));
  return { ops: createChatOps({ client, notebooks: { getNotebook } }), calls, audit, id: account.id };
}

describe("askNotebook with the real client", () => {
  const chatHandler: Handler = () => res(200, { body: frames(chunk(ANSWER, { cites: [cite("c1", S1, "x")], final: true })) });
  const convHandler: Handler = () => res(200, { body: batchBody("hPTbtc", [[[CONV]]]) });

  it("one chat POST + one conversation lookup; audit rows are outcome-only (no question, no answer)", async () => {
    const s = await realSetup([rotateOk, home, chatHandler, convHandler]);
    const r = await s.ops.askNotebook(s.id, NB, { question: QUESTION });
    expect(r.answer).toBe(ANSWER);
    expect(r.conversationId).toBe(CONV);
    expect(s.audit.map((a) => [a.tool, a.outcome])).toEqual([
      ["chat_ask", "ok"],
      ["chat_ask", "ok"],
    ]);
    const dump = JSON.stringify(s.audit);
    expect(dump).not.toContain(QUESTION);
    expect(dump).not.toContain(ANSWER);
  });

  it("daily chat cap: the second ask is refused before any network call", async () => {
    const s = await realSetup([rotateOk, home, chatHandler, convHandler], { chat: 1 });
    await s.ops.askNotebook(s.id, NB, { question: "q1" });
    const callsBefore = s.calls.length;
    await expect(s.ops.askNotebook(s.id, NB, { question: "q2" })).rejects.toBeInstanceOf(DailyCapReachedError);
    expect(s.calls).toHaveLength(callsBefore);
    expect(s.audit.at(-1)!.outcome).toBe("error:daily_cap");
  });
});
