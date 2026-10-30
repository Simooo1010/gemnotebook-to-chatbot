// Fixtures are SYNTHETIC. No network: the Google side is a scripted fake fetch.
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "@/lib/google/supabase";
import { MemoryUsageCounter } from "@/lib/google/throttle";
import { batchBody, fakeClock, homepageHtml, res, scriptedFetch, synthJar, SYN_SID } from "@/lib/google/testing";
import { MemoryCreatedObjects } from "@/lib/notebooklm/created";
import { RuntimeConfigError, createRuntime, createUsageAndAuditFromEnv, resolveNotebookBaseUrl } from "@/lib/runtime";
import { createTools } from "@/lib/tools";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), VAULT_KEY_VERSION: "1" });

describe("resolveNotebookBaseUrl", () => {
  it("defaults to notebook.google.com, normalises to the origin, rejects non-https and junk", () => {
    expect(resolveNotebookBaseUrl({})).toBe("https://notebook.google.com");
    expect(resolveNotebookBaseUrl({ NOTEBOOKLM_BASE_URL: "  " })).toBe("https://notebook.google.com");
    expect(resolveNotebookBaseUrl({ NOTEBOOKLM_BASE_URL: "https://notebooklm.google.com/x" })).toBe("https://notebooklm.google.com");
    expect(() => resolveNotebookBaseUrl({ NOTEBOOKLM_BASE_URL: "http://notebook.google.com" })).toThrow(RuntimeConfigError);
    expect(() => resolveNotebookBaseUrl({ NOTEBOOKLM_BASE_URL: "not a url" })).toThrow(RuntimeConfigError);
  });
});

describe("createUsageAndAuditFromEnv", () => {
  it("uses memory outside production", () => {
    const r = createUsageAndAuditFromEnv({ NODE_ENV: "development" });
    expect(r.usage).toBeInstanceOf(MemoryUsageCounter);
    expect(r.audit).toBeInstanceOf(MemoryAuditSink);
  });
  it("fails closed in production without Supabase, and on half-configured Supabase", () => {
    expect(() => createUsageAndAuditFromEnv({ NODE_ENV: "production" })).toThrow(/not configured/);
    expect(() => createUsageAndAuditFromEnv({ NODE_ENV: "development", SUPABASE_URL: "https://x.supabase.co" })).toThrow(/must both be set/);
  });
  it("builds Supabase adapters when configured (no call is made at construction)", () => {
    const r = createUsageAndAuditFromEnv({ NODE_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" });
    expect(r.usage).not.toBeInstanceOf(MemoryUsageCounter);
  });
});

describe("createRuntime end to end (fake fetch)", () => {
  async function setup(handlers: Parameters<typeof scriptedFetch>[0], env: Record<string, string | undefined> = {}) {
    const clock = fakeClock();
    const accounts = new MemoryAccountRepo();
    const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
    const { account } = await vault.connectAccount("Main", synthJar().cookies);
    const { fetch, calls } = scriptedFetch(handlers);
    const audit = new MemoryAuditSink();
    const rt = createRuntime({ env, vault, created: new MemoryCreatedObjects(), usage: new MemoryUsageCounter(), audit, fetch, now: clock.now, sleep: clock.sleep });
    return { rt, calls, audit, account, accounts, tools: createTools(() => rt) };
  }
  const row = (i: number, title: string) => [title, null, uuid(i), "📘", null, [1, null, null, null, null, [1_700_000_000], null, null, [1_700_000_000]]];

  it("notebooks_list goes vault -> throttle -> client -> decoder and writes an audit row without secrets", async () => {
    const s = await setup([() => res(200), () => res(200, { body: homepageHtml() }), () => res(200, { body: batchBody("wXbhsf", [[row(1, "Alpha")]]) })]);
    const r = await s.tools.notebooksList.run({});
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ account: { label: "Main" }, notebooks: [{ id: uuid(1), title: "Alpha", role: "owner" }], total: 1 });
    expect(s.calls.some((c) => c.url.startsWith("https://notebook.google.com/_/LabsTailwindUi/data/batchexecute"))).toBe(true);
    expect(s.audit.rows).toHaveLength(1);
    expect(s.audit.rows[0]).toMatchObject({ accountId: s.account.id, tool: "LIST_NOTEBOOKS", outcome: "ok" });
    expect(JSON.stringify(s.audit.rows)).not.toContain(SYN_SID);
  });

  it("source_add_url goes tools -> source ops -> client: one mutation (izAoDd) then one status read, audit row without secrets", async () => {
    const nb = uuid(1);
    const srcRow = [[uuid(9)], "Example page", [null, 10, [1_700_000_000], null, 5, null, null, ["https://example.com/p"]], [null, 1]];
    const s = await setup([
      () => res(200),
      () => res(200, { body: homepageHtml() }),
      () => res(200, { body: batchBody("izAoDd", [[[[uuid(9)], "Example page"]]]) }),
      () => res(200, { body: batchBody("rLM1Ne", [["NB", [srcRow], nb]]) }),
    ]);
    const r = await s.tools.sourceAddUrl.run({ notebookId: nb, url: "https://example.com/p" });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ source: { id: uuid(9), title: "Example page", status: "processing" }, reconciled: false });
    expect(s.audit.rows.map((x) => x.tool)).toEqual(["source_add_url", "GET_NOTEBOOK"]);
    expect(JSON.stringify(s.audit.rows)).not.toContain(SYN_SID);
  });

  it("honours NOTEBOOKLM_BASE_URL", async () => {
    const s = await setup(
      [() => res(200), () => res(200, { body: homepageHtml() }), () => res(200, { body: batchBody("wXbhsf", [[]]) })],
      { NOTEBOOKLM_BASE_URL: "https://notebooklm.google.com" },
    );
    await s.tools.notebooksList.run({});
    expect(s.calls.some((c) => c.url.startsWith("https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute"))).toBe(true);
  });

  it("a signed-out session flags the account needs_reauth and the tool says to re-import", async () => {
    const s = await setup([() => res(200), () => res(302, { location: "https://accounts.google.com/ServiceLogin?x=1" }), () => res(200, { body: "<html>sign in</html>" })]);
    const r = await s.tools.notebooksList.run({});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("re-import this account on the vault page");
    expect((await s.accounts.get(s.account.id))!.status).toBe("needs_reauth");
    expect(r.content[0]!.text).not.toContain(SYN_SID);
    // a second call now fails at account resolution, before any Google call
    const again = await s.tools.notebooksList.run({});
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toMatch(/No account is usable|re-import/);
  });

  it("markNeedsReauth never re-enables a disabled account", async () => {
    const accounts = new MemoryAccountRepo();
    const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
    const { account } = await vault.connectAccount("Main", synthJar().cookies);
    await vault.killAccount(account.id);
    await vault.markNeedsReauth(account.id);
    expect((await accounts.get(account.id))!.status).toBe("disabled");
    await vault.markNeedsReauth("missing-id"); // no throw
  });
});
