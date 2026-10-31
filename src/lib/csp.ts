// Content-Security-Policy builder (pure, tested). See next.config.ts for the residual-risk notes on script-src.

export type CspKind = "page" | "consent";

/**
 * "page": every HTML page. Forms may only post to ourselves.
 * "consent": the OAuth consent page only. Its form POSTs to /oauth/consent, which answers with a redirect back to the
 * client (claude.ai). Chromium enforces `form-action` on that redirect, so 'self' alone silently blocks Approve/Deny.
 * The redirect target is validated server-side (exact match against the app's registered https or loopback URI) and the
 * page renders no user-supplied HTML, so allowing https (and loopback http for development) here is the narrowest
 * static policy that still works for any registered client.
 */
export function buildCsp(kind: CspKind, isDev: boolean): string {
  const formAction = kind === "consent" ? "form-action 'self' https: http://localhost:* http://127.0.0.1:*" : "form-action 'self'";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    formAction,
    "base-uri 'none'",
  ].join("; ");
}
