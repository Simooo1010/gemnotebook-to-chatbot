import type { RandomBytes } from "./crypto";
import type { OAuthStore } from "./store";

/** Everything the pure OAuth logic needs: storage, clock and randomness are injected. */
export interface OAuthDeps {
  store: OAuthStore;
  now: () => number;
  random: RandomBytes;
}

/** RFC 6749 / 7591 error. `description` is safe to show; it never contains codes or tokens. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
