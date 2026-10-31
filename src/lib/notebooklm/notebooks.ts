// Typed notebook operations on top of the Google client (SPEC §2, §5). Writes are limited to the created_objects allow-list.
import { z } from "zod";
import type { GoogleClient } from "@/lib/google/client";
import { AmbiguousMutationError } from "@/lib/google/errors";
import {
  createNotebookParams,
  getNotebookParams,
  listNotebooksParams,
  notebookSummaryParams,
  renameNotebookParams,
} from "@/lib/rpc/params";
import { resolveRpcId } from "@/lib/rpc/ids";
import {
  decodeCreateNotebook,
  decodeGetNotebook,
  decodeNotebookList,
  decodeNotebookSummary,
  type Notebook,
  type NotebookDetail,
} from "@/lib/rpc/rows";
import type { CreatedObjects } from "./created";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
/** A notebook counts as "just created" if Google stamped it within this window before our request. */
const RECONCILE_WINDOW_MS = 60_000;

const notebookId = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(200);
const limitSchema = z.number().int().min(1).max(MAX_PAGE_LIMIT);

export class NotWritableError extends Error {
  readonly kind = "not_writable";
  constructor(readonly notebookId: string) {
    super(`notebook ${notebookId} was not created by this connector, so it cannot be modified (write allow-list)`);
  }
}

export class InvalidCursorError extends Error {
  readonly kind = "invalid_cursor";
  constructor() {
    super("invalid pagination cursor");
  }
}

/** Create failed ambiguously and listing found no matching new notebook: nothing was created, retrying is safe. */
export class CreateNotAppliedError extends Error {
  readonly kind = "create_not_applied";
  constructor(readonly cause: AmbiguousMutationError) {
    super("notebook creation failed and no matching notebook exists after re-listing; it is safe to retry");
  }
}

/** Create failed ambiguously and several notebooks could be the result: nothing was recorded. */
export class CreateAmbiguousError extends Error {
  readonly kind = "create_ambiguous";
  constructor(readonly candidateIds: string[]) {
    super(`notebook creation was ambiguous: ${candidateIds.length} notebooks match the title; check the list before retrying`);
  }
}

export interface NotebookPage {
  notebooks: Notebook[];
  nextCursor: string | null;
  total: number;
}

export interface NotebookOpsDeps {
  client: Pick<GoogleClient, "rpc">;
  created: CreatedObjects;
  rpcOverridesJson?: string | null;
  now?: () => number;
}

function encodeCursor(offset: number, lastId: string): string {
  return Buffer.from(JSON.stringify({ o: offset, l: lastId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { o: number; l: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (v && typeof v === "object" && Number.isInteger((v as { o: unknown }).o) && (v as { o: number }).o >= 0 && typeof (v as { l: unknown }).l === "string") {
      return v as { o: number; l: string };
    }
  } catch {
    /* fall through */
  }
  throw new InvalidCursorError();
}

/** Pure paging over the full list. The cursor remembers the last id so a shifted list does not repeat or skip items. */
export function pageNotebooks(all: Notebook[], opts: { limit?: number; cursor?: string | null } = {}): NotebookPage {
  const limit = limitSchema.parse(opts.limit ?? DEFAULT_PAGE_LIMIT);
  let start = 0;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    const at = all.findIndex((n) => n.id === c.l);
    start = at >= 0 ? at + 1 : Math.min(c.o, all.length);
  }
  const notebooks = all.slice(start, start + limit);
  const end = start + notebooks.length;
  const last = notebooks[notebooks.length - 1];
  return { notebooks, nextCursor: end < all.length && last ? encodeCursor(end, last.id) : null, total: all.length };
}

export function createNotebookOps(deps: NotebookOpsDeps) {
  const now = deps.now ?? Date.now;
  const rpcId = (n: Parameters<typeof resolveRpcId>[0]) => resolveRpcId(n, deps.rpcOverridesJson);

  async function fetchAll(accountId: string): Promise<Notebook[]> {
    const result = await deps.client.rpc({
      accountId,
      name: "LIST_NOTEBOOKS",
      params: listNotebooksParams(),
      kind: "read",
      allowNull: true,
    });
    return result === null ? [] : decodeNotebookList(result, rpcId("LIST_NOTEBOOKS"));
  }

  async function listNotebooks(accountId: string, opts: { limit?: number; cursor?: string | null } = {}): Promise<NotebookPage> {
    limitSchema.parse(opts.limit ?? DEFAULT_PAGE_LIMIT); // validate before any network
    if (opts.cursor) decodeCursor(opts.cursor);
    return pageNotebooks(await fetchAll(accountId), opts);
  }

  async function reconcileCreate(accountId: string, title: string, startedAt: number, cause: AmbiguousMutationError) {
    let all: Notebook[];
    try {
      all = await fetchAll(accountId);
    } catch {
      throw cause; // could not look: report the original ambiguity
    }
    const known = new Set(await deps.created.list(accountId, "notebook"));
    const candidates = all.filter(
      (n) =>
        n.title === title &&
        n.role === "owner" &&
        !known.has(n.id) &&
        (n.createdSec === null || n.createdSec * 1000 >= startedAt - RECONCILE_WINDOW_MS),
    );
    if (candidates.length === 0) throw new CreateNotAppliedError(cause);
    if (candidates.length > 1) throw new CreateAmbiguousError(candidates.map((c) => c.id));
    const id = candidates[0]!.id;
    await deps.created.record(accountId, "notebook", id);
    return { id, title, reconciled: true as const };
  }

  async function createNotebook(accountId: string, title: string): Promise<{ id: string; title: string; reconciled: boolean }> {
    const t = titleSchema.parse(title);
    const startedAt = now();
    let result: unknown;
    try {
      result = await deps.client.rpc({ accountId, name: "CREATE_NOTEBOOK", params: createNotebookParams(t), kind: "mutate" });
    } catch (e) {
      if (e instanceof AmbiguousMutationError) return reconcileCreate(accountId, t, startedAt, e);
      throw e;
    }
    const { id } = decodeCreateNotebook(result, rpcId("CREATE_NOTEBOOK"));
    await deps.created.record(accountId, "notebook", id);
    return { id, title: t, reconciled: false };
  }

  async function getNotebook(accountId: string, id: string): Promise<NotebookDetail> {
    const nb = notebookId.parse(id);
    const result = await deps.client.rpc({ accountId, name: "GET_NOTEBOOK", params: getNotebookParams(nb), notebookId: nb, kind: "read" });
    return decodeGetNotebook(result, rpcId("GET_NOTEBOOK"));
  }

  /** Allow-listed: refuses (before any network call) unless this app created the notebook. */
  async function renameNotebook(accountId: string, id: string, title: string): Promise<{ id: string; title: string }> {
    const nb = notebookId.parse(id);
    const t = titleSchema.parse(title);
    if (!(await deps.created.has(accountId, "notebook", nb))) throw new NotWritableError(nb);
    await deps.client.rpc({
      accountId,
      name: "RENAME_NOTEBOOK",
      params: renameNotebookParams(nb, t),
      notebookId: nb,
      kind: "mutate",
      allowNull: true,
    });
    return { id: nb, title: t };
  }

  async function notebookSummary(accountId: string, id: string) {
    const nb = notebookId.parse(id);
    const result = await deps.client.rpc({
      accountId,
      name: "NOTEBOOK_SUMMARY",
      params: notebookSummaryParams(nb),
      notebookId: nb,
      kind: "read",
      allowNull: true,
    });
    return decodeNotebookSummary(result, rpcId("NOTEBOOK_SUMMARY"));
  }

  return { listNotebooks, createNotebook, getNotebook, renameNotebook, notebookSummary };
}

export type NotebookOps = ReturnType<typeof createNotebookOps>;
