import {
  RpcAuthError,
  RpcDriftError,
  RpcNoFramesError,
  RpcQuotaError,
  RpcStatusError,
} from "./errors";

/** PROTOCOL §2.2 response parsing. Pure. */

export function stripAntiXssi(text: string): string {
  return text.startsWith(")]}'") ? text.slice(4).replace(/^\r?\n/, "") : text;
}

/** All envelopes from all chunks, in order. Non-JSON lines (length counts) are skipped. */
export function parseEnvelopes(text: string): unknown[][] {
  const out: unknown[][] = [];
  for (const line of stripAntiXssi(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(t);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk)) continue;
    for (const env of chunk) if (Array.isArray(env)) out.push(env);
  }
  return out;
}

function hasUserDisplayableError(v: unknown): boolean {
  if (typeof v === "string") return v.includes("UserDisplayableError");
  if (Array.isArray(v)) return v.some(hasUserDisplayableError);
  return false;
}

function statusError(rpcId: string, status: unknown): Error | null {
  if (!Array.isArray(status)) return null;
  if (hasUserDisplayableError(status)) return new RpcQuotaError(rpcId, "user_displayable");
  const code = status[0];
  if (typeof code !== "number") return null;
  if (code === 16) return new RpcAuthError(rpcId, "grpc_16");
  if (code === 8) return new RpcQuotaError(rpcId, "grpc_8");
  return new RpcStatusError(rpcId, code);
}

export interface DecodeOptions {
  allowNull?: boolean;
}

/**
 * Returns JSON.parse(envelope[2]) of the LAST non-null wrb.fr frame for rpcId.
 * Throws typed errors otherwise. With allowNull, a null frame without error returns null.
 */
export function decodeBatchResponse(text: string, rpcId: string, opts: DecodeOptions = {}): unknown {
  const envs = parseEnvelopes(text);
  const rpcEnvs = envs.filter((e) => e[0] === "wrb.fr" || e[0] === "er");
  if (rpcEnvs.length === 0) throw new RpcNoFramesError(rpcId);
  const mine = rpcEnvs.filter((e) => e[1] === rpcId);
  if (mine.length === 0) {
    const found = [...new Set(rpcEnvs.map((e) => String(e[1])))];
    throw new RpcDriftError(rpcId, found);
  }
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e[0] === "wrb.fr" && typeof e[2] === "string") {
      const parsed: unknown = JSON.parse(e[2]);
      if (parsed !== null) return parsed;
    }
  }
  for (const e of mine) {
    if (e[0] === "er") {
      const code = typeof e[2] === "number" ? e[2] : undefined;
      throw statusError(rpcId, [code]) ?? new RpcStatusError(rpcId, -1);
    }
    const err = statusError(rpcId, e[5]);
    if (err) throw err;
  }
  if (opts.allowNull) return null;
  throw new RpcDriftError(rpcId, [rpcId], "<null result>");
}
