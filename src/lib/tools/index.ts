// MCP tools (SPEC §3): accounts + notebooks. Handlers are plain functions over a ToolRuntime so tests need no MCP server.
import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { ToolRuntime } from "@/lib/runtime";
import type { Account } from "@/lib/vault/storage";
import {
  MAX_TEXT_CONTENT_CHARS,
  MAX_URL_CHARS,
  driveFileIdSchema,
  driveMimeSchema,
  driveTitleSchema,
  sourceTextContentSchema,
  sourceTextTitleSchema,
  sourceUrlSchema,
  sourceYoutubeSchema,
  type AddedSource,
} from "@/lib/notebooklm/sources";
import { MAX_QUESTION_CHARS, conversationIdSchema, questionSchema } from "@/lib/notebooklm/chat";
import { MEDIA_CONTENT_TYPE, DEFAULT_TTL_SECONDS } from "@/lib/notebooklm/media-link";
import {
  MAX_FOCUS_PROMPT_CHARS,
  MAX_STYLE_PROMPT_CHARS,
  NEXT_CHECK_SECONDS,
  VIDEO_STYLE_RULE,
  artifactIdSchema,
  audioShape,
  videoShape,
  videoStyleRuleOk,
  type CreatedOverview,
} from "@/lib/notebooklm/studio";
import { resolveAccount } from "./accounts";
import { MAX_CHAT_RESULT_CHARS, MAX_TEXT_RESULT_CHARS, ok, toolError, type ToolResult } from "./result";

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

const sourceIdArg = z.string().uuid().describe("Source id (UUID) from notebook_get or from the source_add_* result.");
const MAX_GUIDE_CHARS = 20_000;
const MAX_KEYWORDS = 50;

const WAIT_NOTE =
  "Importing happens in the background. Do not wait or poll inside one call: call notebook_get again after 15 seconds or more and look for this source with status 'ready'.";
const ADD_DESC_TAIL =
  " It adds one new source to the notebook (nothing is changed or deleted) and is not retried automatically: if the result says the outcome is unclear, call notebook_get before adding again. The result has the source id, title and a first status (processing, preparing, ready or error); a new source usually needs a while to become 'ready', so call notebook_get again after 15 seconds or more instead of waiting. Works on any notebook of the account.";

const ADD_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const READ_GOOGLE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function def<S extends z.ZodObject>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

export function createTools(getRuntime: () => ToolRuntime) {
  /** Runs `fn` with the resolved account; every failure becomes a safe isError result. */
  async function withAccount(
    requested: string | undefined,
    fn: (rt: ToolRuntime, account: Account) => Promise<unknown>,
    maxChars?: number,
  ): Promise<ToolResult> {
    try {
      const rt = getRuntime();
      const account = resolveAccount(await rt.listAccounts(), requested);
      return ok(await fn(rt, account), maxChars);
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

  const addResult = (acc: Account, notebookId: string, s: AddedSource) => ({
    account: who(acc),
    notebookId,
    source: { id: s.sourceId, title: s.title, status: s.status },
    reconciled: s.reconciled,
    next: s.status === "ready" ? "The source is ready." : WAIT_NOTE,
  });

  const sourceAddUrl = def({
    name: "source_add_url",
    title: "Add a web page as a source",
    description: `Add a web page (http or https URL) to a notebook as a source.${ADD_DESC_TAIL}`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      url: sourceUrlSchema.describe(`Public http(s) URL, at most ${MAX_URL_CHARS} characters, no username or password in it.`),
    }),
    annotations: ADD_WRITE,
    run: ({ account, notebookId, url }) =>
      withAccount(account, async (rt, acc) => addResult(acc, notebookId, await rt.sources.addSourceUrl(acc.id, notebookId, url))),
  });

  const sourceAddYoutube = def({
    name: "source_add_youtube",
    title: "Add a YouTube video as a source",
    description: `Add a YouTube video (youtube.com or youtu.be URL) to a notebook as a source.${ADD_DESC_TAIL}`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      url: sourceYoutubeSchema.describe("YouTube video URL (youtube.com or youtu.be)."),
    }),
    annotations: ADD_WRITE,
    run: ({ account, notebookId, url }) =>
      withAccount(account, async (rt, acc) => addResult(acc, notebookId, await rt.sources.addSourceYoutube(acc.id, notebookId, url))),
  });

  const sourceAddText = def({
    name: "source_add_text",
    title: "Add pasted text as a source",
    description: `Add a piece of text you provide to a notebook as a source, with a title.${ADD_DESC_TAIL}`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      title: sourceTextTitleSchema.describe("Title of the source (1-200 characters)."),
      content: sourceTextContentSchema.describe(`The text (1-${MAX_TEXT_CONTENT_CHARS} characters).`),
    }),
    annotations: ADD_WRITE,
    run: ({ account, notebookId, title, content }) =>
      withAccount(account, async (rt, acc) => addResult(acc, notebookId, await rt.sources.addSourceText(acc.id, notebookId, title, content))),
  });

  const sourceAddDrive = def({
    name: "source_add_drive",
    title: "Add a Google Drive file as a source",
    description: `Add a Google Drive file (Google Doc, Slides, Sheet, or PDF) that the connected Google account can open to a notebook as a source.${ADD_DESC_TAIL}`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      fileId: driveFileIdSchema.describe("The Drive file id (the long id inside the file's URL)."),
      mimeType: driveMimeSchema.describe("Type of the file: Google Doc, Slides, Sheet, or application/pdf."),
      title: driveTitleSchema.describe("Title to show for the source (1-200 characters)."),
    }),
    annotations: ADD_WRITE,
    run: ({ account, notebookId, fileId, mimeType, title }) =>
      withAccount(account, async (rt, acc) => addResult(acc, notebookId, await rt.sources.addSourceDrive(acc.id, notebookId, { fileId, mimeType, title }))),
  });

  const sourceGetText = def({
    name: "source_get_text",
    title: "Read the text of a source",
    description:
      "Read the plain text of one source in a notebook. Only works when the source status is 'ready' (check with notebook_get; wait 15 seconds or more between checks). Long texts are cut at 60000 characters: 'truncated' is true then and 'totalChars' gives the full length.",
    inputSchema: z.object({ account: accountArg, notebookId: notebookIdArg, sourceId: sourceIdArg }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId, sourceId }) =>
      withAccount(account, async (rt, acc) => {
        const t = await rt.sources.getSourceText(acc.id, notebookId, sourceId);
        return { account: who(acc), notebookId, source: { id: t.sourceId, title: t.title }, text: t.text, truncated: t.truncated, totalChars: t.totalChars };
      }, MAX_TEXT_RESULT_CHARS),
  });

  const sourceGetGuide = def({
    name: "source_get_guide",
    title: "Get a source's summary and keywords",
    description:
      "Get NotebookLM's own short summary and keywords for one source. Only works when the source status is 'ready' (check with notebook_get; wait 15 seconds or more between checks).",
    inputSchema: z.object({ account: accountArg, notebookId: notebookIdArg, sourceId: sourceIdArg }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId, sourceId }) =>
      withAccount(account, async (rt, acc) => {
        const g = await rt.sources.getSourceGuide(acc.id, notebookId, sourceId);
        return {
          account: who(acc),
          notebookId,
          source: { id: g.sourceId, title: g.title },
          summary: g.summary.slice(0, MAX_GUIDE_CHARS),
          summaryTruncated: g.summary.length > MAX_GUIDE_CHARS,
          keywords: g.keywords.slice(0, MAX_KEYWORDS),
        };
      }),
  });


  // --- Studio: audio and video overviews ---
  const CREATE_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const STUDIO_TAIL =
    ` Generation runs in the background and takes from a few minutes to over 30 minutes, so this call returns at once with an artifactId and never waits. Free Google accounts only get a few audio and video overviews per day, and this connector also keeps its own daily limit per account: if a limit is reached the call says so and nothing is started (it is never retried automatically). Only sources that are 'ready' are used; if the notebook has none, nothing is started. Next step: call studio_status (no more often than every ${NEXT_CHECK_SECONDS} seconds) until the overview is 'ready' with readyMedia true, then call studio_download_link. If the result says the outcome is unclear, call studio_status before starting another one. It adds one new overview to the notebook (nothing is changed or deleted).`;
  const sourceIdsArg = audioShape.sourceIds.describe("Optional: only use these sources (ids from notebook_get; all must be 'ready'). Leave out to use every ready source.");
  const languageArg = audioShape.language.describe("Language of the overview as a code such as 'en', 'it', 'de' or 'pt-BR'. Default 'en'.");
  const focusArg = audioShape.focusPrompt.describe(`Optional: what the overview should focus on (at most ${MAX_FOCUS_PROMPT_CHARS} characters).`);
  const createdResult = (acc: Account, notebookId: string, r: CreatedOverview) => ({
    account: who(acc),
    notebookId,
    artifactId: r.artifactId,
    type: r.type,
    status: r.status,
    sourcesUsed: r.sourceCount,
    ...(r.reconciled ? { note: "The request had an unclear first answer; the new overview was found by re-reading the notebook, so nothing was created twice." } : {}),
    nextCheckInSeconds: NEXT_CHECK_SECONDS,
    next: `Call studio_status with this artifactId after ${NEXT_CHECK_SECONDS} seconds or more. Do not wait inside one call.`,
  });

  const studioAudioCreate = def({
    name: "studio_audio_create",
    title: "Start an audio overview",
    description: `Start a NotebookLM audio overview (a spoken, podcast-style conversation about the notebook's sources) in a notebook.${STUDIO_TAIL}`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      format: audioShape.format.describe("deep_dive (default, in-depth discussion), brief (short summary), critique (constructive review) or debate (two sides)."),
      length: audioShape.length.describe("short, default or long."),
      language: languageArg,
      focusPrompt: focusArg,
      sourceIds: sourceIdsArg,
    }),
    annotations: CREATE_WRITE,
    run: ({ account, notebookId, ...opts }) =>
      withAccount(account, async (rt, acc) => createdResult(acc, notebookId, await rt.studio.createAudioOverview(acc.id, notebookId, opts))),
  });

  const studioVideoCreate = def({
    name: "studio_video_create",
    title: "Start a video overview",
    description: `Start a NotebookLM video overview (a narrated video with slides and visuals about the notebook's sources) in a notebook.${STUDIO_TAIL}`,
    inputSchema: z
      .object({
        account: accountArg,
        notebookId: notebookIdArg,
        format: videoShape.format.describe("explainer (default, thorough) or brief (short)."),
        style: videoShape.style.describe("Visual style: auto (default), classic, whiteboard, heritage, paper_craft, watercolor, anime, retro_print, kawaii, or custom (then stylePrompt is required)."),
        stylePrompt: videoShape.stylePrompt.describe(`Only with style 'custom': describe the look in your own words (at most ${MAX_STYLE_PROMPT_CHARS} characters).`),
        language: languageArg,
        focusPrompt: focusArg,
        sourceIds: sourceIdsArg,
      })
      .refine(videoStyleRuleOk, VIDEO_STYLE_RULE),
    annotations: CREATE_WRITE,
    run: ({ account, notebookId, ...opts }) =>
      withAccount(account, async (rt, acc) => createdResult(acc, notebookId, await rt.studio.createVideoOverview(acc.id, notebookId, opts))),
  });

  const studioStatus = def({
    name: "studio_status",
    title: "Check audio and video overview status",
    description: `Check the audio and video overviews of a notebook. Returns up to 20 rows, newest first: artifactId, type (audio, video or other), title, status (queued, generating, ready or failed), readyMedia (true when the file can be downloaded) and createdAt. Pass artifactId to check one overview. Generation takes a few minutes to over 30 minutes: poll no more often than nextCheckInSeconds (at least ${NEXT_CHECK_SECONDS}), never in a tight loop. When status is 'ready' and readyMedia is true, call studio_download_link. A 'failed' overview is not retried by this connector.`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      artifactId: artifactIdSchema.optional().describe("Optional: only this overview (artifactId from studio_audio_create / studio_video_create)."),
      type: z.enum(["audio", "video"]).optional().describe("Optional: only audio or only video overviews."),
    }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId, artifactId, type }) =>
      withAccount(account, async (rt, acc) => {
        const r = await rt.studio.getStudioStatus(acc.id, notebookId, { artifactId, type });
        return {
          account: who(acc),
          notebookId,
          artifacts: r.artifacts,
          total: r.total,
          nextCheckInSeconds: r.nextCheckInSeconds,
          note:
            r.nextCheckInSeconds > 0
              ? `Something is still generating. Check again in ${r.nextCheckInSeconds} seconds or more, not sooner.`
              : "Nothing is generating right now.",
        };
      }),
  });

  const studioDownloadLink = def({
    name: "studio_download_link",
    title: "Get a download link for an overview",
    description:
      "Get a short-lived link to play or save a finished audio (m4a) or video (mp4) overview. Only works when studio_status shows the overview as 'ready' with readyMedia true. The link is on this connector's own domain, opens in any browser (including a phone), expires after 15 minutes by default (up to 60), and anyone who has the link can download that one file until it expires, so give it only to the user. Ask for a new link if it expires.",
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      artifactId: artifactIdSchema.describe("artifactId of a ready audio or video overview (from studio_status)."),
      expiresInMinutes: z.number().int().min(1).max(60).optional().describe(`Minutes the link stays valid (default ${DEFAULT_TTL_SECONDS / 60}, max 60).`),
    }),
    annotations: READ_GOOGLE,
    run: ({ account, notebookId, artifactId, expiresInMinutes }) =>
      withAccount(account, async (rt, acc) => {
        const target = await rt.studio.getMedia(acc.id, notebookId, artifactId); // re-checks ready + media; the Google URL stays server side
        const link = rt.links.create({ accountId: acc.id, notebookId, artifactId: target.artifactId, kind: target.kind, ttlSeconds: expiresInMinutes === undefined ? undefined : expiresInMinutes * 60 });
        return {
          account: who(acc),
          notebookId,
          artifactId: target.artifactId,
          type: target.kind,
          title: target.title,
          url: link.url,
          expiresAt: link.expiresAt.toISOString(),
          contentType: MEDIA_CONTENT_TYPE[target.kind],
          note: "Give this link to the user to open, play or save. It stops working at expiresAt; ask again for a fresh one.",
        };
      }),
  });

  // --- Chat with citations ---
  const chatAsk = def({
    name: "chat_ask",
    title: "Ask a notebook a question",
    description: `Ask a NotebookLM notebook a question and get an answer with citations. The answer comes only from the notebook's own sources (never from general knowledge or the web), and cites them with [N] markers in the text; the 'citations' list maps each number N to the source (sourceId, sourceTitle when known) and the quoted passage. Tell the user the answer is based on their sources and keep the [N] markers or turn them into references. By default all 'ready' sources are used; pass sourceIds (from notebook_get, all must be 'ready') to narrow it. If the notebook has no ready source nothing is sent. The first answer returns a conversationId: pass it back as conversationId to ask a follow-up in the same conversation (the follow-up is understood in context). Questions can be up to ${MAX_QUESTION_CHARS} characters. This adds one turn to the notebook's chat history (nothing is changed or deleted) and is never retried automatically; free Google accounts have a daily chat limit and this connector also keeps its own daily chat cap per account: when it is reached the call says so and nothing is sent. Starting a brand-new conversation is not supported yet. The answer may also include suggestedQuestions.`,
    inputSchema: z.object({
      account: accountArg,
      notebookId: notebookIdArg,
      question: questionSchema.describe(`The question (1 to ${MAX_QUESTION_CHARS} characters).`),
      sourceIds: z.array(z.string().uuid()).min(1).max(300).optional().describe("Optional: only answer from these sources (ids from notebook_get; all must be 'ready'). Leave out to use every ready source."),
      conversationId: conversationIdSchema.optional().describe("Optional: the conversationId from a previous chat_ask answer, to continue that conversation."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: ({ account, notebookId, question, sourceIds, conversationId }) =>
      withAccount(
        account,
        async (rt, acc) => {
          const r = await rt.chat.askNotebook(acc.id, notebookId, { question, sourceIds, conversationId });
          return {
            account: who(acc),
            notebookId,
            ...r,
            note: [
              "The answer is based only on the notebook's sources; [N] markers refer to the citations list.",
              ...(r.answerTruncated || r.citationsOmitted > 0 ? ["Part of the result was cut for size: ask a narrower question or use sourceIds for more detail."] : []),
              ...(r.conversationId ? ["To ask a follow-up in this conversation, pass this conversationId."] : ["No conversationId could be read, so a follow-up starts from the notebook's current conversation."]),
            ].join(" "),
          };
        },
        MAX_CHAT_RESULT_CHARS,
      ),
  });
  return {
    accountsList,
    notebooksList,
    notebookCreate,
    notebookRename,
    notebookGet,
    notebookSummary,
    sourceAddUrl,
    sourceAddYoutube,
    sourceAddText,
    sourceAddDrive,
    sourceGetText,
    sourceGetGuide,
    studioAudioCreate,
    studioVideoCreate,
    studioStatus,
    studioDownloadLink,
    chatAsk,
  };
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
  register(server, t.sourceAddUrl);
  register(server, t.sourceAddYoutube);
  register(server, t.sourceAddText);
  register(server, t.sourceAddDrive);
  register(server, t.sourceGetText);
  register(server, t.sourceGetGuide);
  register(server, t.studioAudioCreate);
  register(server, t.studioVideoCreate);
  register(server, t.studioStatus);
  register(server, t.studioDownloadLink);
  register(server, t.chatAsk);
}

