// Fixtures are SYNTHETIC. The fake runtime never touches the network.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AccountNeedsReauthError,
  AmbiguousMutationError,
  CookieMismatchError,
  CooldownActiveError,
  DailyCapReachedError,
  DisallowedHostError,
  HttpStatusError,
  NetworkError,
  RegionGateError,
  SignedOutError,
  StaleTokenMutationError,
  UnknownHomepageError,
} from "@/lib/google/errors";
import { CreatedObjectsConfigError } from "@/lib/notebooklm/created";
import { CreateAmbiguousError, CreateNotAppliedError, InvalidCursorError, NotWritableError, type NotebookOps } from "@/lib/notebooklm/notebooks";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "@/lib/rpc/errors";
import { RuntimeConfigError, type ToolRuntime } from "@/lib/runtime";
import { KeyringConfigError, VaultCryptoError } from "@/lib/vault/crypto";
import { JarError } from "@/lib/vault/jar";
import type { Account } from "@/lib/vault/storage";
import { VaultStorageError } from "@/lib/vault/supabase";
import { VaultError } from "@/lib/vault/vault";
import { resolveAccount, AccountResolutionError } from "./accounts";
import { createTools } from "./index";
import { MAX_RESULT_CHARS, ok, toolError } from "./result";

const SECRETS = ["SYNTHETIC_SID_VALUE_x1", "nlm_at_SECRETTOKEN", "SNlM0e-SECRET", "Bearer abc", "stack-frame-at-file.ts"];
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const acct = (id: string, label: string, status: Account["status"] = "active"): Account => ({ id, label, emailHash: null, status, createdAt: new Date(0) });
const A1 = acct("a1", "Main");
const A2 = acct("a2", "Work");

type Ops = { [K in keyof NotebookOps]: ReturnType<typeof vi.fn> };
function fake(accounts: Account[], ops: Partial<Ops> = {}) {
  const notebooks = {
    listNotebooks: vi.fn(),
    createNotebook: vi.fn(),
    getNotebook: vi.fn(),
    renameNotebook: vi.fn(),
    notebookSummary: vi.fn(),
    ...ops,
  } as Ops;
  const rt: ToolRuntime = { listAccounts: async () => accounts, notebooks: notebooks as unknown as NotebookOps };
  return { tools: createTools(() => rt), notebooks };
}
const body = (r: { content: { text: string }[] }) => r.content[0]!.text;
const json = (r: { content: { text: string }[] }) => JSON.parse(body(r)) as Record<string, unknown>;

describe("resolveAccount", () => {
  it("implies the only active account, ignoring disabled / needs_reauth ones", () => {
    expect(resolveAccount([A1], undefined)).toBe(A1);
    expect(resolveAccount([acct("x", "Old", "disabled"), A1, acct("y", "Stale", "needs_reauth")], "")).toBe(A1);
  });

  it("requires the argument with several active accounts and lists the choices", () => {
    try {
      resolveAccount([A1, A2]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AccountResolutionError);
      expect((e as AccountResolutionError).kind).toBe("account_required");
      expect((e as Error).message).toContain("Main (id a1)");
      expect((e as Error).message).toContain("Work (id a2)");
    }
  });

  it("matches by id or case-insensitive label; unknown and ambiguous labels fail clearly", () => {
    expect(resolveAccount([A1, A2], "a2")).toBe(A2);
    expect(resolveAccount([A1, A2], " work ")).toBe(A2);
    expect(() => resolveAccount([A1, A2], "nope")).toThrow(/No account matches/);
    expect(() => resolveAccount([A1, acct("a3", "main")], "MAIN")).toThrow(/More than one account/);
  });

  it("explains disabled, needs_reauth, none, and no-usable-account cases", () => {
    const dis = acct("d", "Off", "disabled");
    const stale = acct("s", "Stale", "needs_reauth");
    expect(() => resolveAccount([dis], "d")).toThrow(/disabled by the owner/);
    expect(() => resolveAccount([stale], "Stale")).toThrow(/re-import this account on the vault page/);
    expect(() => resolveAccount([])).toThrow(/No Google account is connected/);
    expect(() => resolveAccount([dis, stale])).toThrow(/No account is usable/);
  });
});

describe("accounts_list", () => {
  it("returns id, label, status only", async () => {
    const { tools } = fake([{ ...A1, emailHash: "HASH" }, acct("a2", "Work", "needs_reauth")]);
    const r = await tools.accountsList.run({});
    expect(r.isError).toBeUndefined();
    expect(json(r)).toEqual({
      accounts: [
        { id: "a1", label: "Main", status: "active" },
        { id: "a2", label: "Work", status: "needs_reauth" },
      ],
    });
    expect(body(r)).not.toContain("HASH");
  });
});

describe("notebook tools", () => {
  it("notebooks_list resolves the implied account and passes limit/cursor", async () => {
    const { tools, notebooks } = fake([A1]);
    notebooks.listNotebooks!.mockResolvedValue({
      notebooks: [{ id: uuid(1), title: "One", emoji: "📘", role: "owner", lastViewedSec: 5, createdSec: 1_700_000_000 }],
      nextCursor: "CUR",
      total: 3,
    });
    const r = await tools.notebooksList.run({ limit: 1, cursor: "C0" });
    expect(notebooks.listNotebooks).toHaveBeenCalledWith("a1", { limit: 1, cursor: "C0" });
    expect(json(r)).toEqual({
      account: { id: "a1", label: "Main" },
      notebooks: [{ id: uuid(1), title: "One", emoji: "📘", role: "owner", createdAt: "2023-11-14T22:13:20.000Z" }],
      nextCursor: "CUR",
      total: 3,
    });
  });

  it("requires the account when two are active (no Google call made)", async () => {
    const { tools, notebooks } = fake([A1, A2]);
    notebooks.listNotebooks!.mockResolvedValue({ notebooks: [], nextCursor: null, total: 0 });
    const r = await tools.notebooksList.run({});
    expect(r.isError).toBe(true);
    expect(body(r)).toContain("account");
    expect(notebooks.listNotebooks).not.toHaveBeenCalled();
    const r2 = await tools.notebooksList.run({ account: "Work" });
    expect(notebooks.listNotebooks).toHaveBeenCalledWith("a2", expect.anything());
    expect(r2.isError).toBeUndefined();
  });

  it("create and rename return compact results", async () => {
    const { tools, notebooks } = fake([A1]);
    notebooks.createNotebook!.mockResolvedValue({ id: uuid(2), title: "New", reconciled: false });
    notebooks.renameNotebook!.mockResolvedValue({ id: uuid(2), title: "Newer" });
    expect(json(await tools.notebookCreate.run({ title: "New" })).notebook).toEqual({ id: uuid(2), title: "New", reconciled: false });
    expect(json(await tools.notebookRename.run({ notebookId: uuid(2), title: "Newer" })).notebook).toEqual({ id: uuid(2), title: "Newer" });
    expect(notebooks.renameNotebook).toHaveBeenCalledWith("a1", uuid(2), "Newer");
  });

  it("notebook_get lists sources with ids, titles and status, capped at 100", async () => {
    const { tools, notebooks } = fake([A1]);
    const sources = Array.from({ length: 120 }, (_, i) => ({
      id: uuid(1000 + i),
      title: `S${i}`,
      typeCode: 5,
      type: "web_page",
      status: "ready",
      url: "https://example.com/x",
      wordCount: 10,
      createdSec: null,
    }));
    notebooks.getNotebook!.mockResolvedValue({ id: uuid(1), title: "NB", emoji: null, role: "owner", lastViewedSec: null, createdSec: null, sources });
    const out = json(await tools.notebookGet.run({ notebookId: uuid(1) }));
    expect((out.sources as unknown[]).length).toBe(100);
    expect(out).toMatchObject({ sourceCount: 120, sourcesTruncated: true });
    expect((out.sources as { id: string; title: string; status: string }[])[0]).toMatchObject({ id: uuid(1000), title: "S0", status: "ready" });
  });

  it("notebook_summary handles null and long summaries", async () => {
    const { tools, notebooks } = fake([A1]);
    notebooks.notebookSummary!.mockResolvedValueOnce(null).mockResolvedValueOnce({
      summary: "x".repeat(9000),
      suggestedQuestions: [{ question: "Q1", prompt: "P" }],
    });
    expect(json(await tools.notebookSummary.run({ notebookId: uuid(1) }))).toMatchObject({ summary: null, suggestedQuestions: [] });
    const out = json(await tools.notebookSummary.run({ notebookId: uuid(1) }));
    expect((out.summary as string).length).toBe(8000);
    expect(out).toMatchObject({ summaryTruncated: true, suggestedQuestions: ["Q1"] });
  });

  it("declares correct MCP annotations: nothing destructive, reads are read-only", () => {
    const { tools } = fake([A1]);
    for (const t of Object.values(tools)) expect(t.annotations.destructiveHint).toBe(false);
    for (const t of [tools.accountsList, tools.notebooksList, tools.notebookGet, tools.notebookSummary]) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
    expect(tools.accountsList.annotations.openWorldHint).toBe(false);
    expect(tools.notebookCreate.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, openWorldHint: true });
    expect(tools.notebookRename.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, openWorldHint: true });
  });

  it("input schemas reject bad ids, empty titles and out-of-range limits", () => {
    const { tools } = fake([A1]);
    expect(tools.notebookGet.inputSchema.safeParse({ notebookId: "nope" }).success).toBe(false);
    expect(tools.notebookCreate.inputSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(tools.notebooksList.inputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(tools.notebooksList.inputSchema.safeParse({ limit: 100 }).success).toBe(true);
  });
});

describe("error mapping", () => {
  const cases: [string, unknown, RegExp][] = [
    ["needs_reauth", new AccountNeedsReauthError("a1"), /re-import this account on the vault page/],
    ["signed out", new SignedOutError("accounts.google.com"), /re-import this account on the vault page/],
    ["cookie mismatch", new CookieMismatchError("x.google.com"), /re-import this account on the vault page/],
    ["rpc auth", new RpcAuthError("wXbhsf", "grpc_16"), /re-import/],
    ["region gate", new RegionGateError("x.google.com"), /location or network/],
    ["unknown homepage", new UnknownHomepageError("x.google.com", "detail"), /unexpected page/],
    ["no frames", new RpcNoFramesError("wXbhsf"), /unexpected page/],
    ["drift", new RpcDriftError("wXbhsf", ["abc"], "[0][1]"), /format has changed/],
    ["quota", new RpcQuotaError("wXbhsf", "grpc_8"), /usage limit/],
    ["cooldown", new CooldownActiveError("a1", 61_000), /about 61 seconds/],
    ["daily cap", new DailyCapReachedError("a1", "audio", 2), /daily limit for audio \(2\)/],
    ["grpc status", new RpcStatusError("rLM1Ne", 5), /NOT_FOUND/],
    ["ambiguous", new AmbiguousMutationError("CCqFvf", "timeout"), /may or may not/],
    ["stale token", new StaleTokenMutationError("CCqFvf"), /NOT confirmed/],
    ["create not applied", new CreateNotAppliedError(new AmbiguousMutationError("CCqFvf", "t")), /nothing was created/],
    ["create ambiguous", new CreateAmbiguousError([uuid(1), uuid(2)]), /several notebooks/],
    ["not writable", new NotWritableError(uuid(9)), /only change notebooks it created/],
    ["bad cursor", new InvalidCursorError(), /cursor is not valid/],
    ["vault no_session", new VaultError("no_session"), /no stored Google session/],
    ["vault not_active", new VaultError("not_active"), /disabled or needs re-authentication/],
    ["vault not_found", new VaultError("not_found"), /does not exist/],
    ["jar", new JarError("missing_required", ["SID"]), /incomplete or cannot be read/],
    ["decrypt", new VaultCryptoError(), /incomplete or cannot be read/],
    ["keyring config", new KeyringConfigError("VAULT_ENCRYPTION_KEY missing"), /not set up correctly/],
    ["storage", new VaultStorageError(), /not set up correctly/],
    ["created config", new CreatedObjectsConfigError("x"), /not set up correctly/],
    ["runtime config", new RuntimeConfigError("x"), /not set up correctly/],
    ["http status", new HttpStatusError("wXbhsf", 502), /Could not reach NotebookLM/],
    ["network", new NetworkError("wXbhsf", "timeout"), /Could not reach NotebookLM/],
    ["disallowed host", new DisallowedHostError("evil.example"), /Could not reach NotebookLM/],
    ["zod", (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })(), /Invalid input \(a:/],
    ["unknown", new Error("boom " + SECRETS.join(" ")), /Something went wrong/],
    ["non-error", "plain string " + SECRETS[0], /Something went wrong/],
  ];

  it.each(cases)("%s -> isError with guidance", (_n, err, re) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = toolError(err);
    spy.mockRestore();
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(body(r)).toMatch(re);
    expect(body(r).length).toBeLessThanOrEqual(600);
  });

  it("never leaks secrets, stacks or messages of unknown errors, even if an error's message contains them", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leaky = [
      new Error(SECRETS.join(" ")),
      Object.assign(new AccountNeedsReauthError("a1"), { message: SECRETS.join(" "), stack: "at stack-frame-at-file.ts" }),
      Object.assign(new RpcQuotaError("wXbhsf", "grpc_8"), { message: SECRETS.join(" ") }),
      Object.assign(new RpcDriftError("wXbhsf"), { message: SECRETS.join(" ") }),
      Object.assign(new JarError("invalid_format"), { message: SECRETS.join(" ") }),
      Object.assign(new HttpStatusError("wXbhsf", 500), { message: SECRETS.join(" ") }),
    ];
    for (const e of leaky) {
      const text = body(toolError(e));
      for (const s of SECRETS) expect(text).not.toContain(s);
      expect(text).not.toMatch(/\bat .*\.ts|stack/i);
    }
    // the unknown-error log carries only the class name
    expect(spy.mock.calls.flat().join(" ")).not.toContain("SYNTHETIC_SID_VALUE_x1");
    spy.mockRestore();
  });

  it("tool handlers turn thrown errors (incl. runtime construction failures) into isError results", async () => {
    const { tools, notebooks } = fake([A1]);
    notebooks.listNotebooks!.mockRejectedValue(new AccountNeedsReauthError("a1"));
    const r = await tools.notebooksList.run({});
    expect(r.isError).toBe(true);
    expect(body(r)).toContain("re-import");

    const broken = createTools(() => {
      throw new RuntimeConfigError("usage and audit storage is not configured: set SUPABASE_URL");
    });
    const r2 = await broken.accountsList.run({});
    expect(r2.isError).toBe(true);
    expect(body(r2)).toMatch(/not set up correctly/);
    expect(body(r2)).not.toContain("SUPABASE_URL");
  });
});

describe("ok()", () => {
  it("returns compact JSON and refuses oversized payloads instead of cutting them", () => {
    expect(body(ok({ a: 1 }))).toBe('{"a":1}');
    const big = ok({ x: "y".repeat(MAX_RESULT_CHARS) });
    expect(JSON.parse(body(big))).toMatchObject({ truncated: true });
  });
});
