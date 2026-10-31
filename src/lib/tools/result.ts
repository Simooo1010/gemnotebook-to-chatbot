// MCP tool results: compact JSON text, size-capped. Errors become isError results with plain-language guidance.
import { ZodError } from "zod";
import {
  AccountNeedsReauthError,
  AmbiguousMutationError,
  ChatEmptyResponseError,
  ChatResponseTooLargeError,
  CookieMismatchError,
  CooldownActiveError,
  DailyCapReachedError,
  DisallowedHostError,
  ExpiredAuthError,
  HttpStatusError,
  NetworkError,
  RegionGateError,
  RotateAuthError,
  SignedOutError,
  StaleTokenMutationError,
  TooManyRedirectsError,
  UnknownHomepageError,
} from "@/lib/google/errors";
import { ChatNewThreadUnsupportedError, ChatTurnUnconfirmedError } from "@/lib/notebooklm/chat";
import { CreatedObjectsConfigError } from "@/lib/notebooklm/created";
import { MediaLinkConfigError } from "@/lib/notebooklm/media-link";
import {
  ArtifactNotDownloadableError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  NotEnoughReadySourcesError,
  StudioCreateAmbiguousError,
  StudioCreateUnconfirmedError,
} from "@/lib/notebooklm/studio";
import { SourceAddAmbiguousError, SourceAddUnconfirmedError, SourceNotFoundError, SourceNotReadyError } from "@/lib/notebooklm/sources";
import { CreateAmbiguousError, CreateNotAppliedError, InvalidCursorError, NotWritableError } from "@/lib/notebooklm/notebooks";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "@/lib/rpc/errors";
import { RuntimeConfigError } from "@/lib/runtime";
import { KeyringConfigError, VaultCryptoError } from "@/lib/vault/crypto";
import { VaultConfigError } from "@/lib/vault";
import { isJarError } from "@/lib/vault/jar";
import { VaultStorageError } from "@/lib/vault/supabase";
import { isVaultError } from "@/lib/vault/vault";
import { AccountResolutionError } from "./accounts";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const MAX_RESULT_CHARS = 24_000;
/** Larger cap for tools whose whole purpose is returning text (source_get_text). */
export const MAX_TEXT_RESULT_CHARS = 100_000;
/** chat_ask: answer (10 000) + up to 20 citations of 400-char excerpts, with headroom for JSON escaping. */
export const MAX_CHAT_RESULT_CHARS = 40_000;

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Compact JSON; if it exceeds the cap, say so instead of returning a cut-off (invalid) document. */
export function ok(data: unknown, maxChars: number = MAX_RESULT_CHARS): ToolResult {
  const json = JSON.stringify(data);
  if (json.length <= maxChars) return text(json);
  return text(JSON.stringify({ truncated: true, note: "Result was too large to return. Ask for fewer items (smaller limit) or a narrower request." }));
}

export const fail = (message: string): ToolResult => text(message.slice(0, 600), true);

const REIMPORT = "Ask the owner to re-import this account on the vault page, then try again.";

/** Maps any error to a safe message. Never includes cookies, tokens, stack traces, raw Google bodies or error.message of unknown errors. */
export function toolError(e: unknown): ToolResult {
  if (e instanceof AccountResolutionError) return fail(e.message);
  if (e instanceof ZodError) {
    const parts = e.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    return fail(`Invalid input (${parts.join("; ")}). Fix the arguments and call again.`);
  }
  if (e instanceof InvalidCursorError) return fail("The cursor is not valid. Call again without a cursor, or use the nextCursor from the previous result unchanged.");
  if (e instanceof NotWritableError) {
    return fail("This connector can only change notebooks it created itself. That notebook was not created here, so it was left untouched.");
  }
  if (e instanceof CreateNotAppliedError) return fail("Creating the notebook failed and nothing was created. It is safe to try again.");
  if (e instanceof CreateAmbiguousError) {
    return fail("Creating the notebook failed in an unclear way and several notebooks could be the result. List notebooks to check before trying again.");
  }
  if (e instanceof SourceNotFoundError) {
    return fail("That source id was not found in this notebook. Call notebook_get to see the notebook's sources and their ids.");
  }
  if (e instanceof SourceNotReadyError) {
    const why =
      e.status === "error"
        ? "It failed to import, so it cannot be read. Add it again if needed."
        : "It is still being imported. Call notebook_get again in 15 seconds or more and retry once its status is 'ready'.";
    return fail(`The source is not ready (status: ${e.status}). ${why}`);
  }
  if (e instanceof SourceAddUnconfirmedError) {
    return fail(
      "Adding the source did not give a clear answer and the notebook does not show it yet. Do NOT add it again right away: wait 15 seconds or more, call notebook_get, and add it only if it is still missing.",
    );
  }
  if (e instanceof SourceAddAmbiguousError) {
    return fail("Adding the source gave an unclear answer and several sources could be the result. Call notebook_get to check before adding anything again.");
  }
  if (e instanceof NotEnoughReadySourcesError) {
    const { total, ready } = e.counts;
    const why: Record<NotEnoughReadySourcesError["reason"], string> = {
      no_sources: "The notebook has no sources yet. Add at least one with source_add_url, source_add_youtube, source_add_text or source_add_drive, wait until it is 'ready', then try again.",
      none_ready: `None of the notebook's ${total} source(s) is ready yet. Call notebook_get again after 15 seconds or more and try once at least one source has status 'ready'.`,
      selected_unknown: "One of the sourceIds is not in this notebook. Call notebook_get to see the source ids.",
      selected_not_ready: `One of the chosen sources is not ready yet (${ready} of ${total} are). Call notebook_get again after 15 seconds or more, or leave sourceIds out to use all ready sources.`,
    };
    return fail(`Nothing was started or sent. ${why[e.reason]}`);
  }
  if (e instanceof StudioCreateUnconfirmedError) {
    return fail(
      "Starting the overview did not give a clear answer and no new overview shows up in the notebook. Do NOT start another one right away: wait 15 seconds or more, call studio_status, and start again only if it is still missing.",
    );
  }
  if (e instanceof StudioCreateAmbiguousError) {
    return fail("Starting the overview gave an unclear answer and several new overviews could be the result. Call studio_status to check before starting anything again.");
  }
  if (e instanceof ArtifactNotFoundError) {
    return fail("That artifact id was not found in this notebook. Call studio_status to see the overviews and their ids.");
  }
  if (e instanceof ArtifactNotReadyError) {
    return fail(
      e.status === "failed"
        ? "That overview failed to generate, so there is nothing to download. Start a new one if needed (it counts against the daily limit)."
        : `That overview is not ready yet (status: ${e.status}). Generation can take from a few minutes to over 30 minutes. Call studio_status again after the suggested wait (15 seconds or more) and ask for the link once it is 'ready' with readyMedia true.`,
    );
  }
  if (e instanceof ArtifactNotDownloadableError) {
    return fail("Only audio and video overviews can be downloaded. Use studio_status to find the right artifact id.");
  }
  if (e instanceof ChatNewThreadUnsupportedError) {
    return fail("Starting a fresh conversation is not supported yet, so nothing was sent. Ask again without it; to continue the same thread pass the conversationId from the previous answer.");
  }
  if (e instanceof ChatTurnUnconfirmedError) {
    return fail(
      "The question may or may not have reached NotebookLM (no clear answer came back). Asking again is harmless but uses one of the account's daily chats, so retry at most once, and only if the user still wants the answer.",
    );
  }
  if (e instanceof ChatEmptyResponseError) {
    return fail("NotebookLM answered with an empty reply, so there is no answer to show. The question may have been recorded. Wait a little and ask again once; if it keeps happening, tell the owner.");
  }
  if (e instanceof ChatResponseTooLargeError) {
    return fail("NotebookLM's reply was too large to handle and was discarded. Ask a narrower question, or limit it to fewer sources with sourceIds.");
  }
  if (e instanceof StaleTokenMutationError) {
    return fail("The change was NOT confirmed (the session token was stale and has been refreshed). Check with notebooks_list or notebook_get whether it was applied, then retry only if it was not.");
  }
  if (e instanceof AmbiguousMutationError) {
    return fail("The change may or may not have been applied. Do not retry yet: check with notebooks_list, notebook_get or studio_status first.");
  }
  if (e instanceof AccountNeedsReauthError || e instanceof SignedOutError || e instanceof CookieMismatchError || e instanceof RotateAuthError || e instanceof RpcAuthError) {
    return fail(`This Google account's session has expired or been signed out. ${REIMPORT}`);
  }
  if (e instanceof RegionGateError) {
    return fail("Google is blocking NotebookLM from this server's location or network. Retrying will not help; tell the owner.");
  }
  if (e instanceof UnknownHomepageError || e instanceof RpcNoFramesError) {
    return fail("Google returned an unexpected page instead of NotebookLM data (possibly a block or a change). Do not retry in a loop; tell the owner.");
  }
  if (e instanceof RpcDriftError) {
    return fail("NotebookLM's response format has changed and the connector cannot read it safely. Do not retry; tell the owner the connector needs an update.");
  }
  if (e instanceof RpcQuotaError) {
    return fail("NotebookLM says this account has hit a usage limit (free accounts only get a limited number of chats and audio and video overviews per day). Wait a while before trying again; the connector will not retry automatically.");
  }
  if (e instanceof CooldownActiveError) {
    return fail(`This account is cooling down after a rate limit. Try again in about ${Math.max(1, Math.ceil(e.retryAfterMs / 1000))} seconds.`);
  }
  if (e instanceof DailyCapReachedError) {
    return fail(`The daily limit for ${e.usageKind} (${e.cap}) has been reached for this account. Try again tomorrow (UTC).`);
  }
  if (e instanceof RpcStatusError) {
    return fail(`NotebookLM refused the request (${e.statusName}). Check the notebook id and that the account can access it; do not retry blindly.`);
  }
  if (isVaultError(e)) {
    if (e.code === "no_session") return fail(`This account has no stored Google session. ${REIMPORT}`);
    if (e.code === "not_active") return fail(`This account is disabled or needs re-authentication. ${REIMPORT}`);
    return fail("That account does not exist. Call accounts_list to see the available accounts.");
  }
  if (isJarError(e) || e instanceof VaultCryptoError) {
    return fail(`The stored Google session for this account is incomplete or cannot be read. ${REIMPORT}`);
  }
  if (e instanceof ExpiredAuthError) {
    return fail(
      "Google refused to hand over the media file (the file link or the account's session has expired). Call studio_status to confirm the overview is still 'ready', then call studio_download_link again. If it keeps failing, ask the owner to re-import this account on the vault page.",
    );
  }
  if (e instanceof MediaLinkConfigError || e instanceof KeyringConfigError || e instanceof VaultConfigError || e instanceof CreatedObjectsConfigError || e instanceof RuntimeConfigError || e instanceof VaultStorageError) {
    return fail("The connector's storage or keys are not set up correctly on the server. Tell the owner to check the deployment settings.");
  }
  if (e instanceof HttpStatusError || e instanceof NetworkError || e instanceof DisallowedHostError || e instanceof TooManyRedirectsError) {
    return fail("Could not reach NotebookLM or got an unusable reply. Wait a moment and try once more; if it keeps failing, tell the owner.");
  }
  // Unknown: log the class name only (messages of unknown errors might carry data), answer generically.
  console.error("mcp tool failed:", e instanceof Error ? e.name : typeof e);
  return fail("Something went wrong inside the connector. Try once more; if it keeps failing, tell the owner.");
}
