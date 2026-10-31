import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";
import nextConfig from "../../next.config";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("buildCsp", () => {
  it("regular pages may only post forms to themselves", () => {
    expect(directive(buildCsp("page", false), "form-action")).toBe("form-action 'self'");
  });
  it("the consent page may redirect back to an https client (Chromium enforces form-action on the redirect)", () => {
    const fa = directive(buildCsp("consent", false), "form-action");
    expect(fa).toContain("'self'");
    expect(fa).toContain("https:");
    expect(fa).not.toContain("*.");
    expect(fa).not.toMatch(/(^| )\*( |$)/);
    expect(fa).not.toContain("http: "); // plain http only for loopback
  });
  it("keeps every other directive identical between the two policies", () => {
    const strip = (c: string) => c.split("; ").filter((d) => !d.startsWith("form-action")).join("; ");
    expect(strip(buildCsp("consent", false))).toBe(strip(buildCsp("page", false)));
  });
  it("never allows unsafe-eval in production, frames, or <base>", () => {
    for (const kind of ["page", "consent"] as const) {
      const c = buildCsp(kind, false);
      expect(c).not.toContain("unsafe-eval");
      expect(c).toContain("frame-ancestors 'none'");
      expect(c).toContain("base-uri 'none'");
    }
  });
});

describe("next.config headers", () => {
  it("serves exactly one CSP on the consent page, with the redirect-capable form-action", async () => {
    const rules = await nextConfig.headers!();
    const withCsp = rules.filter((r) => r.headers.some((h) => h.key === "Content-Security-Policy"));
    const consent = withCsp.filter((r) => r.source === "/oauth/authorize");
    expect(consent).toHaveLength(1);
    expect(consent[0]!.headers[0]!.value).toContain("form-action 'self' https:");
    // the general rule must exclude the consent path, otherwise two CSP headers combine and the stricter wins
    const general = withCsp.find((r) => r.source !== "/oauth/authorize")!;
    expect(general.source).toContain("oauth/authorize");
    expect(general.headers[0]!.value).toContain("form-action 'self'");
    expect(general.headers[0]!.value).not.toContain("https:");
  });
});
