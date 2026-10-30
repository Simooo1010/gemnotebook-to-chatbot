/** Transport error taxonomy (SPEC §4). Messages carry classifications and hosts only: never bodies, cookies or tokens. */

export class GoogleTransportError extends Error {
  readonly kind: string = "transport";
}

/** Redirect (or initial URL) points outside the Google allow-list; cookies were not sent there. */
export class DisallowedHostError extends GoogleTransportError {
  override readonly kind = "disallowed_host";
  constructor(readonly host: string) {
    super(`refused to contact non-Google host ${host}`);
  }
}

export class TooManyRedirectsError extends GoogleTransportError {
  override readonly kind = "too_many_redirects";
  constructor(readonly maxHops: number) {
    super(`more than ${maxHops} redirect hops`);
  }
}

/** Media download returned HTML or an empty body: the session has expired. */
export class ExpiredAuthError extends GoogleTransportError {
  override readonly kind = "expired_auth";
  constructor(readonly reason: "html" | "empty" | "http_status", readonly finalHost: string) {
    super(`media fetch looks like expired auth (${reason}) at ${finalHost}`);
  }
}

export type HomepageFailure = "signed_out" | "region_gate" | "cookie_mismatch" | "unknown";

export class HomepageError extends GoogleTransportError {
  constructor(
    readonly classification: HomepageFailure,
    readonly finalHost: string,
    detail?: string,
  ) {
    super(`homepage ${classification} at ${finalHost}${detail ? ` (${detail})` : ""}`);
  }
}
export class SignedOutError extends HomepageError {
  override readonly kind = "signed_out";
  constructor(finalHost: string) {
    super("signed_out", finalHost);
  }
}
export class RegionGateError extends HomepageError {
  override readonly kind = "region_gate";
  constructor(finalHost: string) {
    super("region_gate", finalHost);
  }
}
export class CookieMismatchError extends HomepageError {
  override readonly kind = "cookie_mismatch";
  constructor(finalHost: string) {
    super("cookie_mismatch", finalHost);
  }
}
export class UnknownHomepageError extends HomepageError {
  override readonly kind = "unknown_homepage";
  constructor(finalHost: string, detail?: string) {
    super("unknown", finalHost, detail);
  }
}

export class RotateAuthError extends GoogleTransportError {
  override readonly kind = "rotate_auth";
  constructor(readonly status: number) {
    super(`RotateCookies rejected the session (HTTP ${status})`);
  }
}

export class AccountNeedsReauthError extends GoogleTransportError {
  override readonly kind = "needs_reauth";
  constructor(readonly accountId: string) {
    super(`account ${accountId} needs re-authentication: import a fresh session on the vault page`);
  }
}

export class AmbiguousMutationError extends GoogleTransportError {
  override readonly kind = "ambiguous_mutation";
  constructor(
    readonly rpcId: string,
    readonly reason: string,
  ) {
    super(`mutation ${rpcId} failed ambiguously (${reason}); it may have been applied. Reconcile by listing before retrying.`);
  }
}

/** A mutation was rejected as unauthenticated, but the session is still alive (stale page token). The write was NOT confirmed. */
export class StaleTokenMutationError extends AmbiguousMutationError {
  constructor(rpcId: string) {
    super(rpcId, "auth rejected with a stale token; session is still valid");
    this.message = `mutation ${rpcId} was NOT confirmed: the page token was stale and has been refreshed. List first to check whether it was applied, then retry if it was not.`;
  }
}

export class HttpStatusError extends GoogleTransportError {
  override readonly kind = "http_status";
  constructor(readonly rpcId: string, readonly status: number) {
    super(`RPC ${rpcId}: HTTP ${status}`);
  }
}

export class NetworkError extends GoogleTransportError {
  override readonly kind = "network";
  constructor(readonly rpcId: string, readonly reason: "timeout" | "network") {
    super(`RPC ${rpcId}: ${reason}`);
  }
}

export class DailyCapReachedError extends GoogleTransportError {
  override readonly kind = "daily_cap";
  constructor(
    readonly accountId: string,
    readonly usageKind: string,
    readonly cap: number,
  ) {
    super(`daily ${usageKind} cap of ${cap} reached for this account; try again tomorrow (UTC)`);
  }
}

export class CooldownActiveError extends GoogleTransportError {
  override readonly kind = "cooldown";
  constructor(
    readonly accountId: string,
    readonly retryAfterMs: number,
  ) {
    super(`account is cooling down after a rate limit; retry in ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}
