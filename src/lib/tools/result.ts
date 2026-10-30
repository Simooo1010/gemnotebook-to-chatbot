// MCP tool results: compact JSON text, size-capped. Errors become isError results with plain-language guidance.
import { ZodError } from "zod";
import {
  AccountNeedsReauthError,
  AmbiguousMutationError,
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
import { CreatedObjectsConfigError } from "@/lib/notebooklm/created";
import { CreateAmbiguousError, CreateNotAppliedError, InvalidCursorError, NotWritableError } from "@/lib/notebooklm/notebooks";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError } from "@/lib/rpc/errors";
import { RuntimeConfigError } from "@/lib/runtime";
import { KeyringConfigError, VaultCryptoError } from "@/lib/vault/crypto";
import { VaultConfigError } from "@/lib/vault";
import { JarError } from "@/lib/vault/jar";
import { VaultStorageError } from "@/lib/vault/supabase";
import { VaultError } from "@/lib/vault/vault";
import { AccountResolutionError } from "./accounts";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const MAX_RESULT_CHARS = 24_000;

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Compact JSON; if it exceeds the cap, say so instead of returning a cut-off (invalid) document. */
export function ok(data: unknown): ToolResult {
  const json = JSON.stringify(data);
  if (json.length <= MAX_RESULT_CHARS) return text(json);
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
  if (e instanceof StaleTokenMutationError) {
    return fail("The change was NOT confirmed (the session token was stale and has been refreshed). List notebooks to see whether it was applied, then retry only if it was not.");
  }
  if (e instanceof AmbiguousMutationError) {
    return fail("The change may or may not have been applied. Do not retry yet: list notebooks first to check.");
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
    return fail("NotebookLM says this account has hit a usage limit. Wait a while before trying again; the connector will not retry automatically.");
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
  if (e instanceof VaultError) {
    if (e.code === "no_session") return fail(`This account has no stored Google session. ${REIMPORT}`);
    if (e.code === "not_active") return fail(`This account is disabled or needs re-authentication. ${REIMPORT}`);
    return fail("That account does not exist. Call accounts_list to see the available accounts.");
  }
  if (e instanceof JarError || e instanceof VaultCryptoError) {
    return fail(`The stored Google session for this account is incomplete or cannot be read. ${REIMPORT}`);
  }
  if (e instanceof KeyringConfigError || e instanceof VaultConfigError || e instanceof CreatedObjectsConfigError || e instanceof RuntimeConfigError || e instanceof VaultStorageError) {
    return fail("The connector's storage or keys are not set up correctly on the server. Tell the owner to check the deployment settings.");
  }
  if (e instanceof HttpStatusError || e instanceof NetworkError || e instanceof ExpiredAuthError || e instanceof DisallowedHostError || e instanceof TooManyRedirectsError) {
    return fail("Could not reach NotebookLM or got an unusable reply. Wait a moment and try once more; if it keeps failing, tell the owner.");
  }
  // Unknown: log the class name only (messages of unknown errors might carry data), answer generically.
  console.error("mcp tool failed:", e instanceof Error ? e.name : typeof e);
  return fail("Something went wrong inside the connector. Try once more; if it keeps failing, tell the owner.");
}
