import type { NextConfig } from "next";

/**
 * Content-Security-Policy for the HTML pages (login, vault, consent, home). No external hosts anywhere.
 *
 * RESIDUAL RISK (script-src 'unsafe-inline'): the Next.js App Router streams its RSC payload to the browser in inline
 * <script> tags (self.__next_f.push(...)). Without a per-request nonce those cannot be allowed except with 'unsafe-inline'.
 * A nonce needs a request proxy and forces every page to render dynamically, which is more machinery than this tiny owner-only
 * app justifies. The pages render no user-supplied HTML (React escapes everything), so the remaining defences are still in force:
 * no external hosts, no framing, forms only to ourselves, no <base>, no plugins.
 *
 * style-src 'unsafe-inline': the root layout inlines its small stylesheet and one page uses a style attribute.
 * 'unsafe-eval' is added only for `next dev` (React's dev tooling needs it); never in production.
 */
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/:path*", headers: common },
      // HTML pages only: the JSON/stream endpoints under /api have no markup to protect.
      { source: "/((?!api/).*)", headers: [{ key: "Content-Security-Policy", value: csp }] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
