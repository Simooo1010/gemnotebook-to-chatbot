/** Typed RPC error taxonomy (SPEC §4). Messages never contain response data or secrets. */

export class RpcError extends Error {
  readonly kind: string = "rpc";
}

export class RpcDriftError extends RpcError {
  override readonly kind = "drift";
  constructor(
    readonly rpcId: string,
    readonly foundIds: string[] = [],
    readonly path?: string,
  ) {
    super(
      path
        ? `RPC ${rpcId}: response shape drift at ${path}`
        : `RPC ${rpcId}: no frame for id (found: ${foundIds.join(",") || "none"})`,
    );
  }
}

export const GRPC_NAMES: Record<number, string> = {
  3: "INVALID_ARGUMENT",
  5: "NOT_FOUND",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  16: "UNAUTHENTICATED",
};

export class RpcStatusError extends RpcError {
  override readonly kind = "status";
  readonly statusName: string;
  constructor(
    readonly rpcId: string,
    readonly code: number,
  ) {
    const statusName = GRPC_NAMES[code] ?? "UNKNOWN";
    super(`RPC ${rpcId}: refused with gRPC ${code} ${statusName}`);
    this.statusName = statusName;
  }
}

export class RpcAuthError extends RpcError {
  override readonly kind = "auth";
  constructor(
    readonly rpcId: string,
    readonly reason: "grpc_16" | "http_401" | "http_403",
  ) {
    super(`RPC ${rpcId}: authentication failed (${reason})`);
  }
}

export class RpcQuotaError extends RpcError {
  override readonly kind = "quota";
  constructor(
    readonly rpcId: string,
    readonly reason: "user_displayable" | "grpc_8" | "http_429" | "chat_exhausted",
    readonly retryAfterSec?: number,
  ) {
    super(`RPC ${rpcId}: quota or rate limit (${reason})`);
  }
}

export class RpcNoFramesError extends RpcError {
  override readonly kind = "no_frames";
  constructor(readonly rpcId: string) {
    super(`RPC ${rpcId}: response contained no RPC frames (HTML or anti-bot page?)`);
  }
}

/** Map a non-OK HTTP status to a typed error (null if not one we classify). */
export function errorForHttpStatus(
  rpcId: string,
  status: number,
  retryAfterHeader?: string | null,
): RpcError | null {
  if (status === 401) return new RpcAuthError(rpcId, "http_401");
  if (status === 403) return new RpcAuthError(rpcId, "http_403");
  if (status === 429) {
    const n = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    return new RpcQuotaError(rpcId, "http_429", Number.isFinite(n) && n >= 0 ? n : undefined);
  }
  return null;
}
