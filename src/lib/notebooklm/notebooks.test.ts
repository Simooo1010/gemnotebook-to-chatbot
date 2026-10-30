// Fixtures are SYNTHETIC (built from docs/PROTOCOL.md); replace with real captures in the real-data run.
import { describe, expect, it } from "vitest";
import { createGoogleClient } from "@/lib/google/client";
import { AccountNeedsReauthError, AmbiguousMutationError } from "@/lib/google/errors";
import { createThrottle } from "@/lib/google/throttle";
import { batchBody, fakeClock, homepageHtml, res, scriptedFetch, synthJar, type Handler } from "@/lib/google/testing";
import { loadKeyring } from "@/lib/vault/crypto";
import { MemoryAccountRepo, MemorySessionVault } from "@/lib/vault/memory";
import { createVault } from "@/lib/vault/vault";
import { MemoryCreatedObjects } from "./created";
import {
  CreateAmbiguousError,
  CreateNotAppliedError,
  InvalidCursorError,
  NotWritableError,
  createNotebookOps,
  pageNotebooks,
} from "./notebooks";
import type { Notebook } from "@/lib/rpc/rows";
import type { RpcCall } from "@/lib/google/client";
import { ZodError } from "zod";

const N = null;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const NOW_SEC = Math.floor(Date.UTC(2026, 9, 30, 12, 0, 0) / 1000);
const row = (i: number, title: string, createdSec = NOW_SEC - 86400 * 30, role = 1) => [
  title,
  N,
  uuid(i),
  "📘",
  N,
  [role, N, N, N, N, [createdSec], N, N, [createdSec]],
];
const listResult = (rows: unknown[][]) => [rows];
const nb = (i: number): Notebook => ({ id: uuid(i), title: `T${i}`, emoji: null, role: "owner", lastViewedSec: null, createdSec: null });
const ACC = "acc-1";

function stubClient(responders: ((c: RpcCall) => unknown)[]) {
  const calls: RpcCall[] = [];
  const q = [...responders];
  return {
    calls,
    client: {
      async rpc(c: RpcCall) {
        calls.push(c);
        const r = q.shift();
        if (!r) throw new Error("unexpected rpc");
        return r(c);
      },
    },
  };
}

describe("pageNotebooks", () => {
  const all = Array.from({ length: 45 }, (_, i) => nb(i + 1));

  it("defaults to 20, walks every page exactly once via opaque cursors", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = pageNotebooks(all, { cursor });
      expect(p.notebooks.length).toBeLessThanOrEqual(20);
      expect(p.total).toBe(45);
      seen.push(...p.notebooks.map((n) => n.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.map((n) => n.id));
  });

  it("honours limit, caps at 100, rejects out-of-range", () => {
    expect(pageNotebooks(all, { limit: 5 }).notebooks).toHaveLength(5);
    expect(pageNotebooks(all, { limit: 100 }).nextCursor).toBeNull();
    expect(() => pageNotebooks(all, { limit: 101 })).toThrow(ZodError);
    expect(() => pageNotebooks(all, { limit: 0 })).toThrow(ZodError);
  });

  it("cursor is opaque and malformed cursors are rejected", () => {
    const c = pageNotebooks(all, { limit: 10 }).nextCursor!;
    expect(c).not.toContain(all[9]!.id);
    for (const bad of ["!!!", Buffer.from("{}").toString("base64url"), Buffer.from('{"o":-1,"l":"x"}').toString("base64url")]) {
      expect(() => pageNotebooks(all, { cursor: bad })).toThrow(InvalidCursorError);
    }
  });

  it("resumes after the last seen id when the list shifts (new notebook at the front)", () => {
    const first = pageNotebooks(all, { limit: 10 });
    const shifted = [nb(99), ...all];
    const second = pageNotebooks(shifted, { limit: 10, cursor: first.nextCursor });
    expect(second.notebooks[0]!.id).toBe(all[10]!.id);
  });

  it("falls back to the offset when the last id vanished; empty list is fine", () => {
    const c = pageNotebooks(all, { limit: 10 }).nextCursor!;
    const without = all.filter((n) => n.id !== all[9]!.id);
    expect(pageNotebooks(without, { cursor: c, limit: 3 }).notebooks[0]!.id).toBe(without[10]!.id); // best effort: plain offset
    expect(pageNotebooks([], {})).toEqual({ notebooks: [], nextCursor: null, total: 0 });
  });
});

describe("notebook ops (stub client)", () => {
  it("listNotebooks: one RPC (read), paged in memory; null result = empty; bad input never hits the network", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, `T${i + 1}`));
    const s = stubClient([() => listResult(rows), () => N]);
    const ops = createNotebookOps({ client: s.client, created: new MemoryCreatedObjects() });
    const p = await ops.listNotebooks(ACC, { limit: 25 });
    expect(p.notebooks).toHaveLength(25);
    expect(p.nextCursor).not.toBeNull();
    expect(s.calls[0]).toMatchObject({ accountId: ACC, name: "LIST_NOTEBOOKS", kind: "read" });
    expect((await ops.listNotebooks(ACC)).notebooks).toEqual([]);
    await expect(ops.listNotebooks(ACC, { limit: 500 })).rejects.toBeInstanceOf(ZodError);
    await expect(ops.listNotebooks(ACC, { cursor: "garbage" })).rejects.toBeInstanceOf(InvalidCursorError);
    expect(s.calls).toHaveLength(2);
  });

  it("createNotebook: mutation, records the id in created_objects, validates the title", async () => {
    const s = stubClient([() => ["T", N, uuid(7)]]);
    const created = new MemoryCreatedObjects();
    const ops = createNotebookOps({ client: s.client, created });
    expect(await ops.createNotebook(ACC, "  My title ")).toEqual({ id: uuid(7), title: "My title", reconciled: false });
    expect(s.calls[0]).toMatchObject({ name: "CREATE_NOTEBOOK", kind: "mutate" });
    expect(await created.has(ACC, "notebook", uuid(7))).toBe(true);
    for (const bad of ["", "   ", "x".repeat(201)]) await expect(ops.createNotebook(ACC, bad)).rejects.toBeInstanceOf(ZodError);
    expect(s.calls).toHaveLength(1);
  });

  it("createNotebook: ambiguous failure → lists, finds the new notebook by title, records it", async () => {
    const now = Date.UTC(2026, 9, 30, 12, 0, 0);
    const s = stubClient([
      () => {
        throw new AmbiguousMutationError("CCqFvf", "timeout");
      },
      () => listResult([row(1, "Old", NOW_SEC - 99999), row(2, "Plan", NOW_SEC - 5), row(3, "Plan", NOW_SEC - 86400 * 400)]),
    ]);
    const created = new MemoryCreatedObjects();
    const ops = createNotebookOps({ client: s.client, created, now: () => now });
    expect(await ops.createNotebook(ACC, "Plan")).toEqual({ id: uuid(2), title: "Plan", reconciled: true });
    expect(s.calls.map((c) => c.name)).toEqual(["CREATE_NOTEBOOK", "LIST_NOTEBOOKS"]);
    expect(await created.list(ACC, "notebook")).toEqual([uuid(2)]);
  });

  it("createNotebook: ambiguous failure and no match → CreateNotAppliedError, nothing recorded", async () => {
    const amb = () => {
      throw new AmbiguousMutationError("CCqFvf", "HTTP 503");
    };
    const s = stubClient([amb, () => listResult([row(1, "Other"), row(2, "Plan", NOW_SEC - 86400 * 10)])]);
    const created = new MemoryCreatedObjects();
    const ops = createNotebookOps({ client: s.client, created, now: () => NOW_SEC * 1000 });
    const e = await ops.createNotebook(ACC, "Plan").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CreateNotAppliedError);
    expect(await created.list(ACC, "notebook")).toEqual([]);
  });

  it("createNotebook: several fresh matches → CreateAmbiguousError, nothing recorded; already-recorded ids are skipped", async () => {
    const amb = () => {
      throw new AmbiguousMutationError("CCqFvf", "timeout");
    };
    const s = stubClient([amb, () => listResult([row(1, "Plan", NOW_SEC - 3), row(2, "Plan", NOW_SEC - 2)]), amb, () => listResult([row(1, "Plan", NOW_SEC - 3), row(2, "Plan", NOW_SEC - 2)])]);
    const created = new MemoryCreatedObjects();
    const ops = createNotebookOps({ client: s.client, created, now: () => NOW_SEC * 1000 });
    const e = (await ops.createNotebook(ACC, "Plan").catch((x: unknown) => x)) as CreateAmbiguousError;
    expect(e).toBeInstanceOf(CreateAmbiguousError);
    expect(e.candidateIds).toEqual([uuid(1), uuid(2)]);
    expect(await created.list(ACC, "notebook")).toEqual([]);
    await created.record(ACC, "notebook", uuid(1)); // an earlier create already owns #1
    expect(await ops.createNotebook(ACC, "Plan")).toMatchObject({ id: uuid(2), reconciled: true });
  });

  it("createNotebook: ambiguous and the reconcile list also fails → original ambiguity is reported; other errors pass through", async () => {
    const amb = new AmbiguousMutationError("CCqFvf", "timeout");
    const s = stubClient([
      () => {
        throw amb;
      },
      () => {
        throw new Error("list failed");
      },
      () => {
        throw new AccountNeedsReauthError(ACC);
      },
    ]);
    const ops = createNotebookOps({ client: s.client, created: new MemoryCreatedObjects() });
    expect(await ops.createNotebook(ACC, "Plan").catch((x: unknown) => x)).toBe(amb);
    expect(await ops.createNotebook(ACC, "Plan").catch((x: unknown) => x)).toBeInstanceOf(AccountNeedsReauthError);
    expect(s.calls).toHaveLength(3);
  });

  it("renameNotebook: only for notebooks in created_objects; refusal makes no RPC", async () => {
    const s = stubClient([() => N]);
    const created = new MemoryCreatedObjects();
    const ops = createNotebookOps({ client: s.client, created });
    const e = await ops.renameNotebook(ACC, uuid(5), "New").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotWritableError);
    expect((e as NotWritableError).kind).toBe("not_writable");
    expect(s.calls).toHaveLength(0);
    await created.record("other-account", "notebook", uuid(5)); // other account's allow-list does not count
    await expect(ops.renameNotebook(ACC, uuid(5), "New")).rejects.toBeInstanceOf(NotWritableError);
    await created.record(ACC, "artifact", uuid(5)); // wrong kind does not count
    await expect(ops.renameNotebook(ACC, uuid(5), "New")).rejects.toBeInstanceOf(NotWritableError);
    await created.record(ACC, "notebook", uuid(5));
    expect(await ops.renameNotebook(ACC, uuid(5), "New")).toEqual({ id: uuid(5), title: "New" });
    expect(s.calls[0]).toMatchObject({ name: "RENAME_NOTEBOOK", kind: "mutate", notebookId: uuid(5) });
    expect(s.calls[0]!.params).toEqual([uuid(5), [[N, N, N, [N, "New"]]]]);
  });

  it("renameNotebook validates uuid and title before anything else", async () => {
    const s = stubClient([]);
    const ops = createNotebookOps({ client: s.client, created: new MemoryCreatedObjects() });
    await expect(ops.renameNotebook(ACC, "not-a-uuid", "x")).rejects.toBeInstanceOf(ZodError);
    await expect(ops.renameNotebook(ACC, uuid(1), "")).rejects.toBeInstanceOf(ZodError);
    await expect(ops.getNotebook(ACC, "../etc")).rejects.toBeInstanceOf(ZodError);
    await expect(ops.notebookSummary(ACC, "nope")).rejects.toBeInstanceOf(ZodError);
    expect(s.calls).toHaveLength(0);
  });

  it("getNotebook returns sources; notebookSummary decodes (and null)", async () => {
    const src = [[uuid(20)], "Doc", [N, 120, [1690000000], N, 5, N, N, ["https://x.y"]], [N, 2]];
    const detail: unknown[] = [...row(1, "NB")]; // row index 1 holds sources
    detail[1] = [src];
    const s = stubClient([() => [detail], () => [[["Sum"], [[["Q1", "P1"]]]]], () => N]);
    const ops = createNotebookOps({ client: s.client, created: new MemoryCreatedObjects() });
    const d = await ops.getNotebook(ACC, uuid(1));
    expect(d).toMatchObject({ id: uuid(1), title: "NB" });
    expect(d.sources).toMatchObject([{ id: uuid(20), status: "ready" }]);
    expect(s.calls[0]).toMatchObject({ name: "GET_NOTEBOOK", kind: "read", notebookId: uuid(1) });
    expect(await ops.notebookSummary(ACC, uuid(1))).toEqual({ summary: "Sum", suggestedQuestions: [{ question: "Q1", prompt: "P1" }] });
    expect(await ops.notebookSummary(ACC, uuid(1))).toBeNull();
    expect(s.calls[1]).toMatchObject({ name: "NOTEBOOK_SUMMARY", kind: "read" });
  });
});

describe("notebook ops through the real client (fake fetch)", () => {
  const keyring = loadKeyring({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), VAULT_KEY_VERSION: "1" });
  const rotateOk: Handler = () => res(200);
  const home: Handler = () => res(200, { body: homepageHtml() });

  async function setup(handlers: Handler[]) {
    const clock = fakeClock();
    const accounts = new MemoryAccountRepo();
    const vault = createVault({ accounts, sessions: new MemorySessionVault(), keyring });
    const { account } = await vault.connectAccount("Synthetic", synthJar().cookies);
    const { fetch, calls } = scriptedFetch(handlers);
    const client = createGoogleClient({
      fetch,
      vault,
      accounts,
      throttle: createThrottle({ now: clock.now, sleep: clock.sleep }),
      audit: { write: async () => undefined },
      config: { base: "https://notebook.google.com" },
      now: clock.now,
    });
    const created = new MemoryCreatedObjects();
    return { ops: createNotebookOps({ client, created, now: clock.now }), calls, created, id: account.id };
  }

  it("create → 503 (ambiguous) → re-list finds it → recorded, never re-POSTed", async () => {
    const s = await setup([
      rotateOk,
      home,
      () => res(503),
      () => res(200, { body: batchBody("wXbhsf", listResult([row(4, "Via fetch", NOW_SEC)])) }),
    ]);
    expect(await s.ops.createNotebook(s.id, "Via fetch")).toEqual({ id: uuid(4), title: "Via fetch", reconciled: true });
    expect(s.calls.filter((c) => c.url.includes("rpcids=CCqFvf"))).toHaveLength(1);
    expect(await s.created.has(s.id, "notebook", uuid(4))).toBe(true);
  });

  it("create → stale-token auth failure → refreshed → re-list finds nothing → not applied, safe to retry", async () => {
    const s = await setup([
      rotateOk,
      home,
      () => res(401),
      home,
      () => res(200, { body: batchBody("wXbhsf", listResult([])) }),
    ]);
    await expect(s.ops.createNotebook(s.id, "Nope")).rejects.toBeInstanceOf(CreateNotAppliedError);
    expect(await s.created.list(s.id, "notebook")).toEqual([]);
  });
});
