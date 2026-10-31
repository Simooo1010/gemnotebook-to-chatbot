import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RpcNoFramesError, RpcQuotaError } from "@/lib/rpc/errors";
import { parseChatResponse } from "@/lib/rpc/chat";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";
import { DEFAULT_CHAT_MAX_BYTES, createGoogleClient, type AuditRow, type GoogleClientConfig } from "./client";
import {
  AccountNeedsReauthError,
  AmbiguousMutationError,
  ChatEmptyResponseError,
  ChatResponseTooLargeError,
  CooldownActiveError,
  DailyCapReachedError,
  RegionGateError,
  StaleTokenMutationError,
} from "./errors";
import { MemoryUsageCounter, createThrottle } from "./throttle";
import { SYN_AT, SYN_SID, SYN_TS, batchBody, fakeClock, homepageHtml, res, scriptedFetch, synthJar, type Handler } from "./testing";

const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), VAULT_KEY_VERSION: "1" });
const rotateOk: Handler = () => res(200, { setCookie: ["SIDCC=SYNTHETIC_SIDCC_x3; Domain=.google.com; Path=/; Secure"] });
const home: Handler = () => res(200, { body: homepageHtml() });
const QUESTION = "SYNTHETIC_QUESTION_TEXT_q1";
const ANSWER = "SYNTHETIC_ANSWER_TEXT_a1";

function chatBody(text = ANSWER): string {
  const inner = [[text, null, ["s", "t"], null, [null, null, null, [], 1]], null, null, null, true, [[]]];
  const line = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
  return `)]}'\n\n${line.length}\n${line}\n`;
}
const chatOk: Handler = () => res(200, { body: chatBody() });

async function setup(handlers: Handler[], cfg: Partial<GoogleClientConfig> = {}, caps?: { chat: number }) {
  const clock = fakeClock();
  const accounts = new MemoryAccountRepo();
  const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
  const { account } = await vault.connectAccount("Synthetic", synthJar().cookies);
  const { fetch, calls } = scriptedFetch(handlers);
  const audit: AuditRow[] = [];
  const usage = new MemoryUsageCounter();
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep, backoffBaseMs: 1000, usage, caps });
  const client = createGoogleClient({
    fetch,
    vault,
    accounts,
    throttle,
    audit: { write: async (r) => void audit.push(r) },
    config: { base: "https://notebook.google.com", ...cfg },
    now: clock.now,
  });
  return { client, calls, audit, accounts, id: account.id, usage, clock };
}

const turn = (id: string) => ({ accountId: id, notebookId: "nb1", params: [[], QUESTION, null, [2, null, [1], [1]], null, null, null, "nb1", 1], usageKind: "chat" as const, tool: "ask" });

function noLeaks(s: string) {
  for (const v of [SYN_SID, SYN_TS, SYN_AT, "SYNTHETIC_SIDCC_x3", QUESTION, ANSWER]) expect(s).not.toContain(v);
}

describe("chatStream transport", () => {
  it("posts per PROTOCOL §2.3 and returns raw text for the parser; clean audit", async () => {
    const s = await setup([rotateOk, home, chatOk]);
    const r = await s.client.chatStream(turn(s.id));
    expect(parseChatResponse(r.text).text).toBe(ANSWER);
    const post = s.calls[2]!;
    expect(post.url).toContain("/GenerateFreeFormStreamed?");
    expect(post.url).toContain("bl=boq_labs-tailwind-frontend_20260802.02_p0");
    expect(post.url).toContain("f.sid=-1234567890123456789");
    expect(post.url).toContain("_reqid=100000");
    expect(post.init.headers!["X-Same-Domain"]).toBe("1");
    expect(post.init.headers!.Cookie).toContain(`SID=${SYN_SID}`);
    expect(post.init.body).toContain(`at=${SYN_AT}`);
    expect(s.audit).toEqual([expect.objectContaining({ tool: "ask", rpcId: "GenerateFreeFormStreamed", outcome: "ok" })]);
    noLeaks(JSON.stringify(s.audit));
  });

  it("req id is monotonic per client", async () => {
    const s = await setup([rotateOk, home, chatOk, chatOk, chatOk]);
    for (let i = 0; i < 3; i++) await s.client.chatStream(turn(s.id));
    expect(s.calls.slice(2).map((c) => new URL(c.url).searchParams.get("_reqid"))).toEqual(["100000", "200000", "300000"]);
  });

  it("serializes with batch RPCs on one account", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = await setup([
      rotateOk,
      home,
      async () => {
        order.push("chat-start");
        await gate;
        order.push("chat-end");
        return res(200, { body: chatBody() });
      },
      () => {
        order.push("rpc");
        return res(200, { body: batchBody("wXbhsf", [1]) });
      },
    ]);
    const a = s.client.chatStream(turn(s.id));
    const b = s.client.rpc({ accountId: s.id, name: "LIST_NOTEBOOKS", params: [], kind: "read" });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["chat-start", "chat-end", "rpc"]);
  });

  it("enforces the daily chat cap", async () => {
    const s = await setup([rotateOk, home, chatOk], {}, { chat: 1 });
    await s.client.chatStream(turn(s.id));
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(DailyCapReachedError);
    expect(s.calls).toHaveLength(3);
    expect(s.audit[1]!.outcome).toBe("error:daily_cap");
  });

  it("429 → quota error, cooldown, no retry", async () => {
    const s = await setup([rotateOk, home, () => res(429, { headers: { "retry-after": "60" } })]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(RpcQuotaError);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(CooldownActiveError);
    expect(s.calls).toHaveLength(3);
  });

  it("401 + signed-out homepage → needs_reauth, no retry", async () => {
    const s = await setup([rotateOk, home, () => res(401), () => res(302, { location: "https://accounts.google.com/ServiceLogin" }), () => res(200, { body: "<html>sign in</html>" })]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect((await s.accounts.get(s.id))?.status).toBe("needs_reauth");
    expect(s.calls.filter((c) => c.url.includes("GenerateFreeFormStreamed"))).toHaveLength(1);
  });

  it("403 + live session → StaleTokenMutationError, tokens refreshed, no retry", async () => {
    const s = await setup([rotateOk, home, () => res(403), home]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(StaleTokenMutationError);
    expect(s.calls).toHaveLength(4);
  });

  it("T3-4: 400 (expired at token) on a chat turn + live session → StaleTokenMutationError, no retry", async () => {
    const s = await setup([rotateOk, home, () => res(400), home]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(StaleTokenMutationError);
    expect(s.calls.filter((c) => c.url.includes("GenerateFreeFormStreamed"))).toHaveLength(1);
  });

  it("5xx and network failure are ambiguous, never retried", async () => {
    const s = await setup([rotateOk, home, () => res(503), () => Promise.reject(new TypeError("fetch failed"))]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(AmbiguousMutationError);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(AmbiguousMutationError);
    expect(s.calls).toHaveLength(4);
  });

  it("T3-11: homepage without cfb2h → the chat URL and the batchexecute URL carry no bl parameter at all", async () => {
    const noBl: Handler = () => res(200, { body: homepageHtml().replace(/,"cfb2h":"[^"]*"/, "") });
    const s = await setup([rotateOk, noBl, chatOk]);
    await s.client.chatStream(turn(s.id));
    expect(s.calls[2]!.url).toContain("/GenerateFreeFormStreamed?");
    expect(s.calls[2]!.url).not.toMatch(/[?&]bl=/);
  });

  it("size cap → typed error", async () => {
    const s = await setup([rotateOk, home, () => res(200, { body: chatBody("x".repeat(5000)) })], { chatMaxBytes: 1000 });
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(ChatResponseTooLargeError);
    expect(s.audit[0]!.outcome).toBe("error:chat_too_large");
  });

  it("T3-9: a real-shaped ~700 KB cumulative chat stream (real answers: 370-710 KB) is accepted under the default cap", async () => {
    const real = (JSON.parse(readFileSync(path.join(__dirname, "../rpc/__fixtures__/chat-stream-final.json"), "utf8")) as { body: string }).body;
    const frames = real.split("\n").filter((l) => l.startsWith("[[\"wrb.fr\""));
    const body = `)]}'\n\n` + Array.from({ length: 24 }, () => frames.join("\n")).join("\n") + "\n";
    expect(Buffer.byteLength(body)).toBeGreaterThan(650_000);
    expect(Buffer.byteLength(body)).toBeLessThan(800_000);
    expect(DEFAULT_CHAT_MAX_BYTES).toBe(8 * 1024 * 1024);
    const s = await setup([rotateOk, home, () => res(200, { body })]);
    const out = await s.client.chatStream(turn(s.id));
    expect(parseChatResponse(out.text).citations).toHaveLength(7);
    // the cap is still enforced when configured lower
    const t = await setup([rotateOk, home, () => res(200, { body })], { chatMaxBytes: 500_000 });
    await expect(t.client.chatStream(turn(t.id))).rejects.toBeInstanceOf(ChatResponseTooLargeError);
  });

  it("timeout → ambiguous (timeout), no retry", async () => {
    const hang: Handler = (_u, init) =>
      new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
    const s = await setup([rotateOk, home, hang], { chatTimeoutMs: 20 });
    const e = await s.client.chatStream(turn(s.id)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AmbiguousMutationError);
    expect((e as AmbiguousMutationError).reason).toBe("timeout");
  });

  it("empty, HTML, region-gate and frameless bodies are typed errors", async () => {
    const s = await setup([
      rotateOk,
      home,
      () => res(200, { body: "" }),
      () => res(200, { body: "<html>oops</html>", headers: { "content-type": "text/html" } }),
      () => res(200, { body: "<html>location=unsupported</html>" }),
      () => res(200, { body: ")]}'\n\n5\n[[1]]\n" }),
    ]);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(ChatEmptyResponseError);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(RpcNoFramesError);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(RegionGateError);
    await expect(s.client.chatStream(turn(s.id))).rejects.toBeInstanceOf(RpcNoFramesError);
  });

  it("quota-exhausted shape (bare e-frame) is passed to the parser", async () => {
    const line = JSON.stringify([["e", 4, null, null, 120]]);
    const s = await setup([rotateOk, home, () => res(200, { body: `)]}'\n\n${line.length}\n${line}\n` })]);
    const r = await s.client.chatStream(turn(s.id));
    expect(() => parseChatResponse(r.text)).toThrow(RpcQuotaError);
  });
});
