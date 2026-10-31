import { buildBatchUrl, buildChatUrl, encodeBatchBody, encodeChatBody, nextReqId } from "@/lib/rpc/batchexecute";
import { CHAT_RPC_LABEL } from "@/lib/rpc/chat";
import { decodeBatchResponse } from "@/lib/rpc/decode";
import { RpcAuthError, RpcError, RpcNoFramesError, RpcQuotaError, RpcStatusError, errorForHttpStatus } from "@/lib/rpc/errors";
import { resolveRpcId, sourcePathFor, type RpcName } from "@/lib/rpc/ids";
import type { CookieJar } from "@/lib/vault/jar";
import type { AccountRepo } from "@/lib/vault/storage";
import {
  AccountNeedsReauthError,
  AmbiguousMutationError,
  ChatEmptyResponseError,
  ChatResponseTooLargeError,
  CookieMismatchError,
  HttpStatusError,
  NetworkError,
  RegionGateError,
  RotateAuthError,
  SignedOutError,
  StaleTokenMutationError,
} from "./errors";
import { browserHeaders, fetchWithJar, type FetchLike } from "./http";
import { rotateCookies, createRotationLimiter, type RotationLimiter } from "./keepalive";
import { createTokenCache, fetchPageTokens, type SessionTokens, type TokenCache } from "./session";
import type { Throttle, UsageKind } from "./throttle";

export interface AuditRow {
  accountId: string;
  tool: string;
  rpcId: string;
  outcome: string;
  at: Date;
}
export interface AuditSink {
  write(row: AuditRow): Promise<void>;
}

export interface ClientVault {
  getJar(accountId: string): Promise<CookieJar>;
  updateJar(accountId: string, jar: CookieJar): Promise<void>;
}

export interface GoogleClientConfig {
  /** e.g. https://notebook.google.com */
  base: string;
  /** Raw NOTEBOOKLM_RPC_OVERRIDES JSON, read by the caller. */
  rpcOverridesJson?: string | null;
  authuser?: string | number;
  rpcTimeoutMs?: number;
  tokenTtlMs?: number;
  /** Chat turn timeout (whole response). Default 120 s. */
  chatTimeoutMs?: number;
  /** Chat response size cap in bytes. Default 2 MB. */
  chatMaxBytes?: number;
}

export interface GoogleClientDeps {
  fetch: FetchLike;
  vault: ClientVault;
  accounts: Pick<AccountRepo, "setStatus">;
  throttle: Throttle;
  audit: AuditSink;
  config: GoogleClientConfig;
  now?: () => number;
  tokenCache?: TokenCache;
  rotationLimiter?: RotationLimiter;
}

export interface RpcCall {
  accountId: string;
  name: RpcName;
  params: unknown;
  notebookId?: string;
  kind: "read" | "mutate";
  usageKind?: UsageKind;
  /** Tool name for the audit row (defaults to the RPC name). */
  tool?: string;
  allowNull?: boolean;
}

/** One chat turn (PROTOCOL §2.3). Always a mutation: never retried. */
export interface ChatStreamCall {
  accountId: string;
  notebookId?: string;
  /** Built by chatParams (Step 3a). */
  params: unknown;
  usageKind: "chat";
  /** Tool name for the audit row. */
  tool: string;
}
export interface ChatStreamResult {
  /** Raw response body for parseChatResponse. Never log it. */
  text: string;
  reqId: number;
}

export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
export const DEFAULT_CHAT_MAX_BYTES = 2 * 1024 * 1024;

async function readCapped(response: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> }, max: number): Promise<string> {
  if (!response.body) {
    const t = await response.text();
    if (Buffer.byteLength(t, "utf8") > max) throw new ChatResponseTooLargeError(max);
    return t;
  }
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let n = 0;
  let out = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new ChatResponseTooLargeError(max);
    }
    out += dec.decode(r.value, { stream: true });
  }
  return out + dec.decode();
}

const sameJar = (a: CookieJar, b: CookieJar) => JSON.stringify(a) === JSON.stringify(b);

function outcomeOf(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e && typeof (e as { kind: unknown }).kind === "string") {
    return `error:${(e as { kind: string }).kind}`;
  }
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return `error:vault_${(e as { code: string }).code}`;
  }
  return "error:internal";
}

export function createGoogleClient(deps: GoogleClientDeps) {
  const now = deps.now ?? Date.now;
  const cache = deps.tokenCache ?? createTokenCache({ now, ttlMs: deps.config.tokenTtlMs });
  const limiter = deps.rotationLimiter ?? createRotationLimiter({ now });
  const base = deps.config.base.replace(/\/+$/, "");

  async function markReauth(accountId: string): Promise<never> {
    cache.invalidate(accountId);
    await deps.accounts.setStatus(accountId, "needs_reauth");
    throw new AccountNeedsReauthError(accountId);
  }

  /** Rotate (rate-limited, PROTOCOL §1.3) then fetch page tokens. Signed-out → needs_reauth. */
  async function freshTokens(accountId: string, jar: CookieJar): Promise<{ tokens: SessionTokens; jar: CookieJar }> {
    let j = jar;
    try {
      j = (await rotateCookies({ fetch: deps.fetch, jar: j, accountId, limiter, now })).jar;
    } catch (e) {
      if (e instanceof RotateAuthError && e.signInRedirect) return markReauth(accountId);
      // Rotation is best-effort (a bare 401/403 may come from an intermediary); the token fetch below decides.
    }
    try {
      const r = await fetchPageTokens({ fetch: deps.fetch, jar: j, base, authuser: deps.config.authuser, now });
      cache.set(accountId, r.tokens);
      return { tokens: r.tokens, jar: r.jar };
    } catch (e) {
      if (e instanceof SignedOutError || e instanceof CookieMismatchError) return markReauth(accountId);
      throw e;
    }
  }

  async function postOnce(call: RpcCall, rpcId: string, tokens: SessionTokens, jar: CookieJar) {
    const url = buildBatchUrl({
      base,
      rpcId,
      sourcePath: sourcePathFor(call.name, call.notebookId),
      fsid: tokens.fsid,
      bl: tokens.bl ?? undefined,
      authuser: deps.config.authuser,
    });
    const body = encodeBatchBody({ rpcId, params: call.params, at: tokens.at });
    const mutate = call.kind === "mutate";
    let res;
    try {
      res = await fetchWithJar(
        deps.fetch,
        jar,
        url,
        {
          method: "POST",
          headers: {
            ...browserHeaders("xhr"),
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: base,
            Referer: `${base}/`,
            "X-Same-Domain": "1",
          },
          body,
          signal: AbortSignal.timeout(deps.config.rpcTimeoutMs ?? 30_000),
        },
        { now },
      );
    } catch (e) {
      const reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
      if (e instanceof RpcError || (e instanceof Error && "kind" in e)) throw e; // typed (e.g. disallowed host)
      if (mutate) throw new AmbiguousMutationError(rpcId, reason);
      throw new NetworkError(rpcId, reason);
    }
    const { response } = res;
    const httpErr = errorForHttpStatus(rpcId, response.status, response.headers.get("retry-after"));
    if (httpErr) throw httpErr;
    if (response.status >= 500) {
      if (mutate) throw new AmbiguousMutationError(rpcId, `HTTP ${response.status}`);
      throw new HttpStatusError(rpcId, response.status);
    }
    if (response.status !== 200) throw new HttpStatusError(rpcId, response.status);
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (mutate) throw new AmbiguousMutationError(rpcId, "body read failed");
      throw new NetworkError(rpcId, "network");
    }
    try {
      return { result: decodeBatchResponse(text, rpcId, { allowNull: call.allowNull }), jar: res.jar };
    } catch (e) {
      if (mutate && e instanceof RpcStatusError && e.code === 3) throw new AmbiguousMutationError(rpcId, "gRPC 3 INVALID_ARGUMENT");
      throw e;
    }
  }

  type Post<T> = (tokens: SessionTokens, jar: CookieJar) => Promise<{ result: T; jar: CookieJar }>;

  function execute(call: RpcCall, rpcId: string): Promise<unknown> {
    return executeWith(call.accountId, rpcId, call.kind === "mutate", (t, j) => postOnce(call, rpcId, t, j));
  }

  async function executeWith<T>(accountId: string, rpcId: string, isMutation: boolean, post: Post<T>): Promise<T> {
    const call = { accountId, kind: isMutation ? "mutate" : "read" };
    const original = await deps.vault.getJar(call.accountId);
    let jar = original;
    let tokens = cache.get(call.accountId);
    if (!tokens) ({ tokens, jar } = await freshTokens(call.accountId, jar));
    try {
      try {
        const r = await post(tokens, jar);
        jar = r.jar;
        return r.result;
      } catch (e) {
        if (!(e instanceof RpcAuthError)) throw e;
        if (call.kind === "mutate") {
          // Never retry a write. First find out (with a read) whether the session is really dead.
          cache.invalidate(call.accountId);
          try {
            const r = await fetchPageTokens({ fetch: deps.fetch, jar, base, authuser: deps.config.authuser, now });
            cache.set(call.accountId, r.tokens);
            jar = r.jar;
          } catch (pe) {
            if (pe instanceof SignedOutError || pe instanceof CookieMismatchError) return await markReauth(call.accountId);
            throw pe;
          }
          throw new StaleTokenMutationError(rpcId);
        }
        // Reads: refresh tokens once and retry once (PROTOCOL §1.4).
        cache.invalidate(call.accountId);
        ({ tokens, jar } = await freshTokens(call.accountId, jar));
        try {
          const r = await post(tokens, jar);
          jar = r.jar;
          return r.result;
        } catch (e2) {
          // A 400 that survives fresh tokens (the homepage check above found a live session) is a bad request,
          // not a dead session: do not flag the account.
          if (e2 instanceof RpcAuthError && e2.reason === "http_400") throw new HttpStatusError(rpcId, 400);
          if (e2 instanceof RpcAuthError) return await markReauth(call.accountId);
          throw e2;
        }
      }
    } catch (e) {
      if (e instanceof RpcQuotaError) deps.throttle.noteQuota(call.accountId, e.retryAfterSec);
      throw e;
    } finally {
      if (!sameJar(original, jar)) {
        await deps.vault.updateJar(call.accountId, jar).catch(() => undefined);
      }
    }
  }

  let lastReqId: number | undefined;

  async function postChat(call: ChatStreamCall, tokens: SessionTokens, jar: CookieJar) {
    const label = CHAT_RPC_LABEL;
    lastReqId = nextReqId(lastReqId);
    const reqId = lastReqId;
    const url = buildChatUrl({ base, bl: tokens.bl ?? "", reqId, fsid: tokens.fsid, authuser: deps.config.authuser });
    const body = encodeChatBody({ params: call.params, at: tokens.at });
    const signal = AbortSignal.timeout(deps.config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
    const isAbort = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    let res;
    try {
      res = await fetchWithJar(
        deps.fetch,
        jar,
        url,
        {
          method: "POST",
          headers: {
            ...browserHeaders("xhr"),
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: base,
            Referer: `${base}/`,
            "X-Same-Domain": "1",
          },
          body,
          signal,
        },
        { now },
      );
    } catch (e) {
      if (e instanceof RpcError || (e instanceof Error && "kind" in e)) throw e;
      throw new AmbiguousMutationError(label, isAbort(e) ? "timeout" : "network");
    }
    const { response } = res;
    const httpErr = errorForHttpStatus(label, response.status, response.headers.get("retry-after"));
    if (httpErr) {
      await response.body?.cancel().catch(() => undefined);
      throw httpErr;
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new AmbiguousMutationError(label, `HTTP ${response.status}`);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(label, response.status);
    }
    let text: string;
    try {
      text = await readCapped(response, deps.config.chatMaxBytes ?? DEFAULT_CHAT_MAX_BYTES);
    } catch (e) {
      if (e instanceof ChatResponseTooLargeError) throw e;
      throw new AmbiguousMutationError(label, isAbort(e) ? "timeout" : "body read failed");
    }
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === ")]}'") throw new ChatEmptyResponseError(label);
    const ct = response.headers.get("content-type") ?? "";
    if (/text\/html/i.test(ct) || trimmed.startsWith("<")) {
      if (/location=unsupported|not available in your (country|region)/i.test(text)) throw new RegionGateError(new URL(res.finalUrl).hostname);
      throw new RpcNoFramesError(label);
    }
    // Frames (or the bare terminal "e" frame of an exhausted quota) are left to parseChatResponse.
    if (!text.includes('"wrb.fr"') && !text.includes('["e"')) throw new RpcNoFramesError(label);
    return { result: { text, reqId } as ChatStreamResult, jar: res.jar };
  }

  return {
    /**
     * One chat turn over the streamed endpoint. Same pipeline as rpc (throttle, daily cap, tokens, jar, audit).
     * A mutation: never retried. Returns the raw body; parse with parseChatResponse.
     */
    async chatStream(call: ChatStreamCall): Promise<ChatStreamResult> {
      let outcome = "ok";
      try {
        const result = await deps.throttle.schedule(
          call.accountId,
          () => executeWith(call.accountId, CHAT_RPC_LABEL, true, (t, j) => postChat(call, t, j)),
          { usageKind: call.usageKind },
        );
        deps.throttle.noteSuccess(call.accountId);
        return result;
      } catch (e) {
        outcome = outcomeOf(e);
        throw e;
      } finally {
        await deps.audit
          .write({ accountId: call.accountId, tool: call.tool, rpcId: CHAT_RPC_LABEL, outcome, at: new Date(now()) })
          .catch(() => undefined);
      }
    },
    async rpc(call: RpcCall): Promise<unknown> {
      const rpcId = resolveRpcId(call.name, deps.config.rpcOverridesJson);
      let outcome = "ok";
      try {
        const result = await deps.throttle.schedule(call.accountId, () => execute(call, rpcId), {
          usageKind: call.usageKind,
        });
        deps.throttle.noteSuccess(call.accountId);
        return result;
      } catch (e) {
        outcome = outcomeOf(e);
        throw e;
      } finally {
        await deps.audit
          .write({ accountId: call.accountId, tool: call.tool ?? call.name, rpcId, outcome, at: new Date(now()) })
          .catch(() => undefined);
      }
    },
    invalidateTokens: (accountId: string) => cache.invalidate(accountId),
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
