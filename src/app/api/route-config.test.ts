// The long-running routes must declare their function limit explicitly (a Next route segment config export),
// so the intent is visible and the platform rejects a plan that cannot honour it. Source check: importing the
// route modules would build the MCP route and read the environment.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const maxDuration = (src: string) => Number(/^export const maxDuration = (\d+);$/m.exec(src)?.[1]);

describe("route maxDuration", () => {
  it("MCP and media routes allow 300 s (Fluid Compute, Hobby maximum)", () => {
    expect(maxDuration(read("mcp/route.ts"))).toBe(300);
    expect(maxDuration(read("media/[token]/route.ts"))).toBe(300);
  });
  it("cron keep-alive and deep health stay at 60 s", () => {
    expect(maxDuration(read("cron/keepalive/route.ts"))).toBe(60);
    expect(maxDuration(read("health/deep/route.ts"))).toBe(60);
  });
});
