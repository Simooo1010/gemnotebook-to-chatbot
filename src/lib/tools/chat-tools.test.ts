// Fixtures are SYNTHETIC. Fake ops; no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { ChatEmptyResponseError, ChatResponseTooLargeError, DailyCapReachedError, AmbiguousMutationError } from "@/lib/google/errors";
import { ChatNewThreadUnsupportedError, ChatTurnUnconfirmedError, type ChatOps, type ChatResult } from "@/lib/notebooklm/chat";
import type { NotebookOps } from "@/lib/notebooklm/notebooks";
import type { SourceOps } from "@/lib/notebooklm/sources";
import { NotEnoughReadySourcesError, type StudioOps } from "@/lib/notebooklm/studio";
import { RpcQuotaError } from "@/lib/rpc/errors";
import type { MediaLinks, ToolRuntime } from "@/lib/runtime";
import type { Account } from "@/lib/vault/storage";
import { createTools } from "./index";
import { MAX_CHAT_RESULT_CHARS, toolError } from "./result";

const NB = "00000000-0000-4000-8000-000000000001";
const S1 = "00000000-0000-4000-8000-000000000011";
const A1: Account = { id: "a1", label: "Main", emailHash: null, status: "active", createdAt: new Date(0) };
const A2: Account = { id: "a2", label: "Other", emailHash: null, status: "active", createdAt: new Date(0) };
const QUESTION = "SYNTHETIC_QUESTION_TEXT_q1";
const ANSWER = "SYNTHETIC_ANSWER_TEXT_a1";
const body = (r: { content: { text: string }[] }) => r.content[0]!.text;
const json = (r: { content: { text: string }[] }) => JSON.parse(body(r)) as Record<string, unknown>;

const RESULT: ChatResult = {
  answer: `${ANSWER} [1]`,
  answerTruncated: false,
  citations: [{ n: 1, sourceId: S1, sourceTitle: "Cat book", excerpt: "Cats sleep.", score: 0.9 }],
  citationsOmitted: 0,
  suggestedQuestions: ["Why?"],
  conversationId: "conv-1",
  sourcesUsed: 1,
};

function fake(accounts: Account[] = [A1]) {
  const chat = { askNotebook: vi.fn() };
  const rt: ToolRuntime = {
    listAccounts: async () => accounts,
    notebooks: {} as NotebookOps,
    sources: {} as SourceOps,
    studio: {} as StudioOps,
    chat: chat as unknown as ChatOps,
    links: {} as MediaLinks,
    media: {} as never,
  };
  return { tools: createTools(() => rt), chat };
}

afterEach(() => vi.restoreAllMocks());

describe("chat_ask definition", () => {
  const { tools } = fake();
  it("is registered as a write-like, non-destructive, non-idempotent, open-world tool with a plain description", () => {
    expect(tools.chatAsk.name).toBe("chat_ask");
    expect(tools.chatAsk.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    const d = tools.chatAsk.description;
    expect(d).toMatch(/only from the notebook's own sources/);
    expect(d).toMatch(/\[N\] markers/);
    expect(d).toMatch(/daily chat limit/);
    expect(d).toMatch(/conversationId/);
  });

  it("schema: question 1-4000, ids validated, no newThread", () => {
    const s = tools.chatAsk.inputSchema;
    expect(s.safeParse({ notebookId: NB, question: "hi" }).success).toBe(true);
    expect(s.safeParse({ notebookId: NB, question: "" }).success).toBe(false);
    expect(s.safeParse({ notebookId: NB, question: "q".repeat(4001) }).success).toBe(false);
    expect(s.safeParse({ notebookId: "x", question: "hi" }).success).toBe(false);
    expect(s.safeParse({ notebookId: NB, question: "hi", sourceIds: ["x"] }).success).toBe(false);
    expect(s.safeParse({ notebookId: NB, question: "hi", sourceIds: [S1], conversationId: "conv-1", account: "a1" }).success).toBe(true);
    expect(Object.keys(s.shape)).not.toContain("newThread");
  });
});

describe("chat_ask run", () => {
  it("passes the arguments through and returns answer, citations, conversation id and a note", async () => {
    const f = fake();
    f.chat.askNotebook.mockResolvedValue(RESULT);
    const r = await f.tools.chatAsk.run({ notebookId: NB, question: QUESTION, sourceIds: [S1], conversationId: "conv-0" });
    expect(f.chat.askNotebook).toHaveBeenCalledWith("a1", NB, { question: QUESTION, sourceIds: [S1], conversationId: "conv-0" });
    expect(r.isError).toBeUndefined();
    const j = json(r);
    expect(j).toMatchObject({ account: { id: "a1", label: "Main" }, notebookId: NB, answer: `${ANSWER} [1]`, conversationId: "conv-1", sourcesUsed: 1 });
    expect(j.citations).toEqual(RESULT.citations);
    expect(String(j.note)).toMatch(/conversationId/);
  });

  it("needs an account when several are active", async () => {
    const f = fake([A1, A2]);
    const r = await f.tools.chatAsk.run({ notebookId: NB, question: "q" });
    expect(r.isError).toBe(true);
    expect(f.chat.askNotebook).not.toHaveBeenCalled();
  });

  it("a maximum-size result fits the chat result cap (not replaced by the 'truncated' notice)", async () => {
    const f = fake();
    f.chat.askNotebook.mockResolvedValue({
      ...RESULT,
      answer: "a".repeat(10_000),
      citations: Array.from({ length: 20 }, (_, i) => ({ n: i + 1, sourceId: S1, sourceTitle: "t".repeat(120), excerpt: '"'.repeat(400), score: 0.123456789 })),
      suggestedQuestions: Array.from({ length: 5 }, () => "s".repeat(150)),
    });
    const r = await f.tools.chatAsk.run({ notebookId: NB, question: "q" });
    expect(body(r).length).toBeLessThanOrEqual(MAX_CHAT_RESULT_CHARS);
    expect(json(r).truncated).toBeUndefined();
    expect((json(r).citations as unknown[]).length).toBe(20);
  });

  it("mentions cut parts in the note", async () => {
    const f = fake();
    f.chat.askNotebook.mockResolvedValue({ ...RESULT, answerTruncated: true, citationsOmitted: 3 });
    expect(String((json(await f.tools.chatAsk.run({ notebookId: NB, question: "q" })).note))).toMatch(/cut for size/);
  });
});

describe("chat error mapping", () => {
  const cases: [string, unknown, RegExp][] = [
    ["quota exhausted", new RpcQuotaError("GenerateFreeFormStreamed", "chat_exhausted"), /usage limit[\s\S]*chats/],
    ["daily cap", new DailyCapReachedError("a1", "chat", 30), /daily limit for chat \(30\)/],
    ["empty response", new ChatEmptyResponseError("GenerateFreeFormStreamed"), /empty reply/],
    ["too large", new ChatResponseTooLargeError(2_000_000), /too large[\s\S]*sourceIds/],
    ["no ready sources", new NotEnoughReadySourcesError("none_ready", { total: 2, ready: 0 }), /Nothing was started or sent[\s\S]*None of the notebook's 2/],
    ["no sources", new NotEnoughReadySourcesError("no_sources", { total: 0, ready: 0 }), /no sources yet/],
    ["unconfirmed turn", new ChatTurnUnconfirmedError(new AmbiguousMutationError("GenerateFreeFormStreamed", "timeout")), /may or may not[\s\S]*at most once/],
    ["new thread", new ChatNewThreadUnsupportedError(), /not supported yet/],
  ];
  it.each(cases)("%s -> isError with a next step", (_n, err, re) => {
    const r = toolError(err);
    expect(r.isError).toBe(true);
    expect(body(r)).toMatch(re);
  });

  it("question and answer text never leak through errors, even if an error message carries them", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = [
      new Error(`boom ${QUESTION} ${ANSWER}`),
      new ZodError([{ code: "custom", path: ["question"], message: "bad", input: QUESTION } as never]),
      new ChatTurnUnconfirmedError(new Error(QUESTION)),
      new ChatEmptyResponseError(QUESTION),
      new RpcQuotaError(QUESTION, "chat_exhausted"),
    ];
    for (const e of hostile) {
      const out = body(toolError(e));
      expect(out).not.toContain(QUESTION);
      expect(out).not.toContain(ANSWER);
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain(QUESTION);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(ANSWER);

    // through the tool: the op throws with the question in its message
    const f = fake();
    f.chat.askNotebook.mockRejectedValue(new Error(`secret ${QUESTION}`));
    const r = await f.tools.chatAsk.run({ notebookId: NB, question: QUESTION });
    expect(r.isError).toBe(true);
    expect(body(r)).not.toContain(QUESTION);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(QUESTION);
  });
});
