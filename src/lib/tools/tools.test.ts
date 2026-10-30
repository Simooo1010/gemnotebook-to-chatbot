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
import {
  SourceAddAmbiguousError,
  SourceAddUnconfirmedError,
  SourceNotFoundError,
  SourceNotReadyError,
  type SourceOps,
} from "@/lib/notebooklm/sources";
import { MediaLinkConfigError } from "@/lib/notebooklm/media-link";
import type { MediaDownloader } from "@/lib/notebooklm/media-download";
import {
  ArtifactNotDownloadableError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  NotEnoughReadySourcesError,
  StudioCreateAmbiguousError,
  StudioCreateUnconfirmedError,
  type StudioOps,
} from "@/lib/notebooklm/studio";
import { ExpiredAuthError } from "@/lib/google/errors";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "@/lib/rpc/errors";
import { RuntimeConfigError, type MediaLinks, type ToolRuntime } from "@/lib/runtime";
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
type SrcOps = { [K in keyof SourceOps]: ReturnType<typeof vi.fn> };
function fake(accounts: Account[], ops: Partial<Ops> = {}, srcOps: Partial<SrcOps> = {}) {
  const notebooks = {
    listNotebooks: vi.fn(),
    createNotebook: vi.fn(),
    getNotebook: vi.fn(),
    renameNotebook: vi.fn(),
    notebookSummary: vi.fn(),
    ...ops,
  } as Ops;
  const sources = {
    addSourceUrl: vi.fn(),
    addSourceYoutube: vi.fn(),
    addSourceText: vi.fn(),
    addSourceDrive: vi.fn(),
    getSourceText: vi.fn(),
    getSourceGuide: vi.fn(),
    ...srcOps,
  } as SrcOps;
  const rt: ToolRuntime = {
    listAccounts: async () => accounts,
    notebooks: notebooks as unknown as NotebookOps,
    sources: sources as unknown as SourceOps,
    studio: {} as StudioOps,
    links: {} as MediaLinks,
    media: {} as MediaDownloader,
  };
  return { tools: createTools(() => rt), notebooks, sources };
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
    ["no sources", new NotEnoughReadySourcesError("no_sources", { total: 0, ready: 0 }), /Nothing was started[\s\S]*no sources yet/],
    ["none ready", new NotEnoughReadySourcesError("none_ready", { total: 3, ready: 0 }), /None of the notebook's 3 source/],
    ["selected unknown", new NotEnoughReadySourcesError("selected_unknown", { total: 3, ready: 3 }), /not in this notebook/],
    ["selected not ready", new NotEnoughReadySourcesError("selected_not_ready", { total: 3, ready: 1 }), /chosen sources is not ready/],
    ["studio create unconfirmed", new StudioCreateUnconfirmedError(new Error("x")), /Do NOT start another one[\s\S]*studio_status/],
    ["studio create ambiguous", new StudioCreateAmbiguousError(["a", "b"]), /several new overviews/],
    ["artifact not found", new ArtifactNotFoundError(), /artifact id was not found/],
    ["artifact generating", new ArtifactNotReadyError("generating"), /not ready yet[\s\S]*30 minutes/],
    ["artifact failed", new ArtifactNotReadyError("failed"), /failed to generate/],
    ["artifact not downloadable", new ArtifactNotDownloadableError(), /Only audio and video/],
    ["media expired", new ExpiredAuthError("html", "x.google.com"), /studio_download_link again/],
    ["media link config", new MediaLinkConfigError(), /not set up correctly/],
    ["source not found", new SourceNotFoundError(), /source id was not found/],
    ["source not ready (processing)", new SourceNotReadyError("processing"), /still being imported[\s\S]*15 seconds/],
    ["source not ready (error)", new SourceNotReadyError("error"), /failed to import/],
    ["source add unconfirmed", new SourceAddUnconfirmedError(new Error("x")), /Do NOT add it again/],
    ["source add ambiguous", new SourceAddAmbiguousError([uuid(1), uuid(2)]), /several sources/],
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
      Object.assign(new SourceAddUnconfirmedError(new Error(SECRETS.join(" "))), { message: SECRETS.join(" ") }),
      Object.assign(new SourceNotReadyError("processing"), { message: SECRETS.join(" ") }),
      Object.assign(new SourceNotFoundError(), { message: SECRETS.join(" ") }),
      Object.assign(new SourceAddAmbiguousError([uuid(3)]), { message: SECRETS.join(" ") }),
      Object.assign(new NotEnoughReadySourcesError("none_ready", { total: 1, ready: 0 }), { message: SECRETS.join(" ") }),
      Object.assign(new StudioCreateUnconfirmedError(new Error(SECRETS.join(" "))), { message: SECRETS.join(" ") }),
      Object.assign(new ArtifactNotReadyError("generating"), { message: SECRETS.join(" ") }),
      Object.assign(new ExpiredAuthError("html", "https://x.google.com/media?sig=SECRET_SIGNED_URL"), { message: SECRETS.join(" ") + " https://lh3.googleusercontent.com/SECRET_SIGNED_URL" }),
      Object.assign(new MediaLinkConfigError(), { message: SECRETS.join(" ") }),
    ];
    for (const e of leaky) {
      const text = body(toolError(e));
      for (const s of SECRETS) expect(text).not.toContain(s);
      expect(text).not.toMatch(/\bat .*\.ts|stack|SECRET_SIGNED_URL|googleusercontent/i);
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

describe("source tools", () => {
  const NB = uuid(1);
  const SID = uuid(50);
  const added = { sourceId: SID, title: "Page", status: "processing" as const, reconciled: false };

  it("add tools resolve the account, call the ops and return id/title/status with the wait hint", async () => {
    const { tools, sources } = fake([A1]);
    sources.addSourceUrl!.mockResolvedValue(added);
    sources.addSourceYoutube!.mockResolvedValue({ ...added, title: "Video" });
    sources.addSourceText!.mockResolvedValue({ ...added, title: "Note" });
    sources.addSourceDrive!.mockResolvedValue({ ...added, status: "ready" });

    const r = json(await tools.sourceAddUrl.run({ notebookId: NB, url: "https://example.com/a" }));
    expect(sources.addSourceUrl).toHaveBeenCalledWith("a1", NB, "https://example.com/a");
    expect(r).toMatchObject({ account: { id: "a1" }, notebookId: NB, source: { id: SID, title: "Page", status: "processing" }, reconciled: false });
    expect(r.next).toMatch(/notebook_get[\s\S]*15 seconds/);

    await tools.sourceAddYoutube.run({ notebookId: NB, url: "https://youtu.be/abcdefghijk" });
    expect(sources.addSourceYoutube).toHaveBeenCalledWith("a1", NB, "https://youtu.be/abcdefghijk");
    await tools.sourceAddText.run({ notebookId: NB, title: "Note", content: "hello" });
    expect(sources.addSourceText).toHaveBeenCalledWith("a1", NB, "Note", "hello");
    const d = json(await tools.sourceAddDrive.run({ notebookId: NB, fileId: "1AbCdEfGhIjKlMnOp", mimeType: "application/pdf", title: "Doc" }));
    expect(sources.addSourceDrive).toHaveBeenCalledWith("a1", NB, { fileId: "1AbCdEfGhIjKlMnOp", mimeType: "application/pdf", title: "Doc" });
    expect(d.next).toBe("The source is ready.");
  });

  it("add tools need an explicit account when several are active (no Google call)", async () => {
    const { tools, sources } = fake([A1, A2]);
    const r = await tools.sourceAddUrl.run({ notebookId: NB, url: "https://example.com" });
    expect(r.isError).toBe(true);
    expect(sources.addSourceUrl).not.toHaveBeenCalled();
  });

  it("source_get_text returns text with the truncated flag, and keeps a 60k text intact (own size cap)", async () => {
    const { tools, sources } = fake([A1]);
    sources.getSourceText!.mockResolvedValue({ sourceId: SID, title: "T", text: "é".repeat(60_000), truncated: true, totalChars: 90_000 });
    const r = await tools.sourceGetText.run({ notebookId: NB, sourceId: SID });
    expect(r.isError).toBeUndefined();
    const out = json(r);
    expect((out.text as string).length).toBe(60_000);
    expect(out).toMatchObject({ truncated: true, totalChars: 90_000, source: { id: SID, title: "T" } });
  });

  it("source_get_guide returns summary and keywords, capped", async () => {
    const { tools, sources } = fake([A1]);
    sources.getSourceGuide!.mockResolvedValue({ sourceId: SID, title: "T", summary: "s".repeat(21_000), keywords: Array.from({ length: 60 }, (_, i) => `k${i}`) });
    const out = json(await tools.sourceGetGuide.run({ notebookId: NB, sourceId: SID }));
    expect((out.summary as string).length).toBe(20_000);
    expect(out).toMatchObject({ summaryTruncated: true });
    expect((out.keywords as string[]).length).toBe(50);
  });

  it("not-ready and unconfirmed-add errors become guidance, not stack traces", async () => {
    const { tools, sources } = fake([A1]);
    sources.getSourceText!.mockRejectedValue(new SourceNotReadyError("processing"));
    sources.addSourceUrl!.mockRejectedValue(new SourceAddUnconfirmedError(new Error(SECRETS.join(" "))));
    const a = await tools.sourceGetText.run({ notebookId: NB, sourceId: SID });
    expect(a.isError).toBe(true);
    expect(body(a)).toMatch(/not ready[\s\S]*notebook_get/);
    const b = await tools.sourceAddUrl.run({ notebookId: NB, url: "https://example.com" });
    expect(b.isError).toBe(true);
    for (const s of SECRETS) expect(body(b)).not.toContain(s);
  });

  it("annotations: adds are write/non-idempotent/open-world/non-destructive; reads are read-only", () => {
    const { tools } = fake([A1]);
    for (const t of [tools.sourceAddUrl, tools.sourceAddYoutube, tools.sourceAddText, tools.sourceAddDrive]) {
      expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(t.description).toMatch(/notebook_get/);
      expect(t.description).toMatch(/15 seconds/);
    }
    for (const t of [tools.sourceGetText, tools.sourceGetGuide]) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    expect(Object.values(tools).map((t) => t.name)).toEqual(
      expect.arrayContaining(["source_add_url", "source_add_youtube", "source_add_text", "source_add_drive", "source_get_text", "source_get_guide"]),
    );
  });

  it("input schemas enforce the validation rules before any call", () => {
    const { tools } = fake([A1]);
    const u = tools.sourceAddUrl.inputSchema;
    expect(u.safeParse({ notebookId: NB, url: "https://example.com/a" }).success).toBe(true);
    for (const bad of ["ftp://example.com", "javascript:alert(1)", "not a url", "https://user:pw@example.com/", "https://example.com/" + "a".repeat(2100)]) {
      expect(u.safeParse({ notebookId: NB, url: bad }).success).toBe(false);
    }
    expect(u.safeParse({ notebookId: "nope", url: "https://example.com" }).success).toBe(false);
    const y = tools.sourceAddYoutube.inputSchema;
    expect(y.safeParse({ notebookId: NB, url: "https://www.youtube.com/watch?v=abc" }).success).toBe(true);
    expect(y.safeParse({ notebookId: NB, url: "https://example.com/watch?v=abc" }).success).toBe(false);
    const t = tools.sourceAddText.inputSchema;
    expect(t.safeParse({ notebookId: NB, title: "", content: "x" }).success).toBe(false);
    expect(t.safeParse({ notebookId: NB, title: "x".repeat(201), content: "x" }).success).toBe(false);
    expect(t.safeParse({ notebookId: NB, title: "ok", content: "" }).success).toBe(false);
    expect(t.safeParse({ notebookId: NB, title: "ok", content: "x".repeat(200_001) }).success).toBe(false);
    expect(t.safeParse({ notebookId: NB, title: "ok", content: "x".repeat(200_000) }).success).toBe(true);
    const d = tools.sourceAddDrive.inputSchema;
    expect(d.safeParse({ notebookId: NB, fileId: "short", mimeType: "application/pdf", title: "t" }).success).toBe(false);
    expect(d.safeParse({ notebookId: NB, fileId: "1AbCdEfGhIjKl/../x", mimeType: "application/pdf", title: "t" }).success).toBe(false);
    expect(d.safeParse({ notebookId: NB, fileId: "1AbCdEfGhIjKlMnOp", mimeType: "text/html", title: "t" }).success).toBe(false);
    expect(tools.sourceGetText.inputSchema.safeParse({ notebookId: NB, sourceId: "x" }).success).toBe(false);
  });
});
