// MCP tools (SPEC §3): accounts + notebooks. Handlers are plain functions over a ToolRuntime so tests need no MCP server.
import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { ToolRuntime } from "@/lib/runtime";
import type { Account } from "@/lib/vault/storage";
import { resolveAccount } from "./accounts";
import { ok, toolError, type ToolResult } from "./result";

type McpServerT = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  run(args: z.infer<S>): Promise<ToolResult>;
}

const MAX_SOURCES = 100;
const MAX_SUMMARY_CHARS = 8000;
const MAX_QUESTIONS = 10;
const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());

const accountArg = z
  .string()
  .max(100)
  .optional()
  .describe("Account id or label from accounts_list. Optional when only one account is connected.");
const notebookIdArg = z.string().uuid().describe("Notebook id (UUID) from notebooks_list.");
const titleArg = z.string().trim().min(1).max(200);

const READ_GOOGLE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function def<S extends z.ZodObject>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

export function createTools(getRuntime: () => ToolRuntime) {
  /** Runs `fn` with the resolved account; every failure becomes a safe isError result. */
  async function withAccount(
    requested: string | undefined,
    fn: (rt: ToolRuntime, account: Account) => Promise<unknown>,
  ): Promise<ToolResult> {
    try {
      const rt = getRuntime();
      const account = resolveAccount(await rt.listAccounts(), requested);
      return ok(await fn(rt, account));
    } catch (e) {
      return toolError(e);
    }
  }
  const who = (a: Account) => ({ id: a.id, label: a.label });

  const accountsList = def({
    name: "accounts_list",
    title: "List Google accounts",
    description:
      "List the Google accounts connected to this NotebookLM connector (id, label, status). Status 'active' means usable; 'needs_reauth' or 'disabled' means the owner must act on the vault page. Use the id or label as the 'account' argument of other tools when more than one account is active.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run() {
      try {
        const accounts = await getRuntime().listAccounts();
        return ok({ accounts: accounts.map((a) => ({ id: a.id, label: a.label, status: a.status })) });
      } catch (e) {
        return toolError(e);
      }
    },
  });

  const notebooksList = def({
    name: "notebooks_list",
    title: "List notebooks",
    description:
      "List the NotebookLM notebooks of an account, 20 per page by default (max 100). If nextCursor is not null, pass it as 'cursor' to get the next page. Each item has id, title, emoji, role and createdAt.",
    inputSchema: z.object({
      account: accountArg,
      limit: z.number().int().min(1).max(100).optional().describe("Notebooks per page (default 20, max 100)."),
      cursor: z.string().max(300).optional().describe("nextCursor from the previous page."),
    }),
    annotations: READ_GOOGLE,
    run: ({ account, limit, cursor }) =>
      withAccount(account, async (rt, acc) => {
        const page = await rt.notebooks.listNotebooks(acc.id, { limit, cursor });
        return {
          account: who(acc),
          notebooks: page.notebooks.map((n) => ({ id: n.id, title: n.title, emoji: n.emoji, role: n.role, createdAt: iso(n.createdSec) })),
          nextCursor: page.nextCursor,
          total: page.total,
        };
      }),
  });

  const notebookCreate = def({
    name: "notebook_create",
    title: "Create a notebook",
    description:
      "Create a new, empty NotebookLM notebook with the given title. It is not retried automatically: if the result says the outcome is unclear, list notebooks before trying again. This connector can later rename only notebooks it created.",
    inputSchema: z.object({ account: accountArg, title: titleArg.describe("Title for the new notebook (1-200 characters).") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: ({ account, title }) =>
      withAccount(account, async (rt, acc) => ({ account: who(acc), notebook: await rt.notebooks.createNotebook(acc.id, title) })),
  });

  const notebookRename = def({
    name: "notebook_rename",
    title: "Rename a notebook",
    description:
      "Rename a notebook. Only notebooks created through this connector can be renamed; any other notebook is refused and left untouched.",
    inputSchema: z.object({ account: accountArg, notebookId: notebookIdArg, title: titleArg.describe("New title (1-200 characters).") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: ({ account, notebookId, title }) =>
      withAccount(account, async (rt, acc) => ({ account: who(acc), notebook: await rt.notebooks.renameNotebook(acc.id, notebookId, title) })),
  });

  const notebookGet = def({
    name: "notebook_get",
    title: "Get a notebook with its sources",
    description:
      "Get one notebook with its list of sources (id, title, type, status, url, wordCount). Source status 'ready' means usable; 'processing' or 'preparing' means wait; 'error' means it failed to import.",
    inputSchema: z.object({ account: accountArg, notebookId: notebookIdArg }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId }) =>
      withAccount(account, async (rt, acc) => {
        const nb = await rt.notebooks.getNotebook(acc.id, notebookId);
        return {
          account: who(acc),
          notebook: { id: nb.id, title: nb.title, emoji: nb.emoji, role: nb.role, createdAt: iso(nb.createdSec) },
          sources: nb.sources.slice(0, MAX_SOURCES).map((s) => ({
            id: s.id,
            title: s.title,
            type: s.type,
            status: s.status,
            url: s.url,
            wordCount: s.wordCount,
          })),
          sourceCount: nb.sources.length,
          sourcesTruncated: nb.sources.length > MAX_SOURCES,
        };
      }),
  });

  const notebookSummary = def({
    name: "notebook_summary",
    title: "Get a notebook summary",
    description:
      "Get NotebookLM's own summary of a notebook plus the follow-up questions it suggests. Returns summary null when the notebook has no sources yet.",
    inputSchema: z.object({ account: accountArg, notebookId: notebookIdArg }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId }) =>
      withAccount(account, async (rt, acc) => {
        const s = await rt.notebooks.notebookSummary(acc.id, notebookId);
        if (s === null) return { account: who(acc), summary: null, suggestedQuestions: [], note: "No summary yet (the notebook may have no sources)." };
        return {
          account: who(acc),
          summary: s.summary.slice(0, MAX_SUMMARY_CHARS),
          summaryTruncated: s.summary.length > MAX_SUMMARY_CHARS,
          suggestedQuestions: s.suggestedQuestions.slice(0, MAX_QUESTIONS).map((q) => q.question),
        };
      }),
  });

  return { accountsList, notebooksList, notebookCreate, notebookRename, notebookGet, notebookSummary };
}

export type Tools = ReturnType<typeof createTools>;

function register<S extends z.ZodObject>(server: McpServerT, tool: ToolDef<S>): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema as z.ZodObject, annotations: tool.annotations },
    async (args: unknown) => {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) return toolError(parsed.error);
      return tool.run(parsed.data as z.infer<S>);
    },
  );
}

export function registerTools(server: McpServerT, getRuntime: () => ToolRuntime): void {
  const t = createTools(getRuntime);
  register(server, t.accountsList);
  register(server, t.notebooksList);
  register(server, t.notebookCreate);
  register(server, t.notebookRename);
  register(server, t.notebookGet);
  register(server, t.notebookSummary);
}

