// Route tests run the real mcp-handler against an in-memory OAuth store and a fake tool runtime. No network.
import { describe, expect, it, vi } from "vitest";
import { sha256hex } from "@/lib/oauth/crypto";
import type { OAuthDeps } from "@/lib/oauth/deps";
import { createMemoryStore } from "@/lib/oauth/store";
import { defaultRandom } from "@/lib/oauth/crypto";
import type { NotebookOps } from "@/lib/notebooklm/notebooks";
import type { SourceOps } from "@/lib/notebooklm/sources";
import type { ToolRuntime } from "@/lib/runtime";
import { PROTECTED_RESOURCE_PATH, createMcpRoute } from "./route";

const BASE = "https://connector.example.com";
const URL_MCP = `${BASE}/api/mcp`;
const GOOD = "nlm_at_" + "G".repeat(43);
const WRONG_SCOPE = "nlm_at_" + "W".repeat(43);
const EXPIRED = "nlm_at_" + "E".repeat(43);
const REVOKED = "nlm_at_" + "R".repeat(43);
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

async function setup(opts: { runtime?: () => ToolRuntime; oauth?: () => OAuthDeps; env?: Record<string, string | undefined> } = {}) {
  const store = createMemoryStore();
  const deps: OAuthDeps = { store, now: () => NOW, random: defaultRandom };
  const put = (raw: string, scope: string, expiresAt: Date, revokedAt: Date | null = null) =>
    store.tokens.insert({ tokenHash: sha256hex(raw), kind: "access", clientId: "client-1", scope, expiresAt, familyId: raw.slice(7, 12), revokedAt, createdAt: new Date(NOW - 1000) });
  await put(GOOD, "notebooklm", new Date(NOW + 3_600_000));
  await put(WRONG_SCOPE, "other", new Date(NOW + 3_600_000));
  await put(EXPIRED, "notebooklm", new Date(NOW - 1));
  await put(REVOKED, "notebooklm", new Date(NOW + 3_600_000), new Date(NOW - 5));
  const runtime: ToolRuntime =
    opts.runtime?.() ?? {
      listAccounts: async () => [{ id: "a1", label: "Main", emailHash: null, status: "active", createdAt: new Date(0) }],
      notebooks: {} as NotebookOps,
      sources: {} as SourceOps,
    };
  const route = createMcpRoute({ env: opts.env ?? { PUBLIC_BASE_URL: BASE }, oauth: opts.oauth ?? (() => deps), runtime: () => runtime });
  return { route, deps, store };
}

const rpc = (method: string, params: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
const post = (body: string, token?: string, extra: Record<string, string> = {}) =>
  new Request(URL_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body,
  });

/** Reads a JSON or SSE response body into the JSON-RPC message it carries. */
async function rpcResult(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const t = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = t.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(data!.slice(5).trim());
  }
  return JSON.parse(t);
}

const INIT = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const EXPECT_CHALLENGE = `resource_metadata="${BASE}${PROTECTED_RESOURCE_PATH}"`;

describe("/api/mcp bearer auth", () => {
  it("no token -> 401 with WWW-Authenticate pointing at the protected-resource metadata", async () => {
    const { route } = await setup();
    const res = await route.handle(post(INIT));
    expect(res.status).toBe(401);
    const h = res.headers.get("www-authenticate")!;
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(EXPECT_CHALLENGE);
    expect(h).toContain("/.well-known/oauth-protected-resource/api/mcp");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["garbage token", "not-a-token"],
    ["unknown nlm token", "nlm_at_" + "Z".repeat(43)],
    ["expired token", EXPIRED],
    ["revoked token", REVOKED],
  ])("%s -> 401 with the same challenge", async (_n, token) => {
    const { route } = await setup();
    const res = await route.handle(post(INIT, token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(EXPECT_CHALLENGE);
  });

  it("a token without the notebooklm scope -> 403", async () => {
    const { route } = await setup();
    const res = await route.handle(post(INIT, WRONG_SCOPE));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain(EXPECT_CHALLENGE);
  });

  it("challenge base comes from PUBLIC_BASE_URL, else the request origin", async () => {
    const { route } = await setup({ env: {} });
    const res = await route.handle(post(INIT));
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}${PROTECTED_RESOURCE_PATH}"`);
    const { route: r2 } = await setup({ env: { PUBLIC_BASE_URL: "https://pinned.example.org/ignored/path" } });
    expect((await r2.handle(post(INIT))).headers.get("www-authenticate")).toContain(`resource_metadata="https://pinned.example.org${PROTECTED_RESOURCE_PATH}"`);
  });

  it("GET without a token is also 401 (never reaches the MCP handler)", async () => {
    const { route } = await setup();
    const res = await route.handle(new Request(URL_MCP, { method: "GET" }));
    expect(res.status).toBe(401);
  });

  it("OAuth storage unavailable -> 503, not 401; storage error mid-verify -> 503", async () => {
    const { route } = await setup({
      oauth: () => {
        throw new Error("not configured");
      },
    });
    expect((await route.handle(post(INIT, GOOD))).status).toBe(503);

    const { route: r2, deps } = await setup();
    deps.store.tokens.get = async () => {
      throw new Error("db down");
    };
    expect((await r2.handle(post(INIT, GOOD))).status).toBe(503);
  });
});

describe("/api/mcp with a valid token", () => {
  it("initialize succeeds and reports the tools capability", async () => {
    const { route } = await setup();
    const res = await route.handle(post(INIT, GOOD));
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ serverInfo: { name: "notebooklm-connector" }, capabilities: { tools: expect.anything() } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("tools/list returns the notebook and source tools with annotations and schemas", async () => {
    const { route } = await setup();
    const res = await route.handle(post(rpc("tools/list", {}, 2), GOOD, { "MCP-Protocol-Version": "2025-06-18" }));
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    const tools = (msg.result as { tools: { name: string; description: string; annotations: Record<string, boolean>; inputSchema: { type: string } }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "accounts_list",
        "notebook_create",
        "notebook_get",
        "notebook_rename",
        "notebook_summary",
        "notebooks_list",
        "source_add_drive",
        "source_add_text",
        "source_add_url",
        "source_add_youtube",
        "source_get_guide",
        "source_get_text",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "notebooks_list")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "notebook_create")!.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "source_add_url")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(tools.find((t) => t.name === "source_get_text")!.annotations.readOnlyHint).toBe(true);
  });

  it("tools/call accounts_list runs through the fake runtime", async () => {
    const { route } = await setup();
    const res = await route.handle(post(rpc("tools/call", { name: "accounts_list", arguments: {} }, 3), GOOD, { "MCP-Protocol-Version": "2025-06-18" }));
    const msg = await rpcResult(res);
    const content = (msg.result as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0]!.text)).toEqual({ accounts: [{ id: "a1", label: "Main", status: "active" }] });
  });

  it("a runtime that cannot start yields an isError tool result, not a crash", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createMemoryStore();
    await store.tokens.insert({ tokenHash: sha256hex(GOOD), kind: "access", clientId: "c", scope: "notebooklm", expiresAt: new Date(NOW + 1e6), familyId: "f", revokedAt: null, createdAt: new Date(NOW) });
    const lazy = createMcpRoute({
      env: { PUBLIC_BASE_URL: BASE },
      oauth: () => ({ store, now: () => NOW, random: defaultRandom }),
      runtime: () => {
        throw new Error("storage not configured SECRET-IN-MESSAGE");
      },
    });
    const res = await lazy.handle(post(rpc("tools/call", { name: "accounts_list", arguments: {} }, 4), GOOD, { "MCP-Protocol-Version": "2025-06-18" }));
    const msg = await rpcResult(res);
    const r = msg.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("SECRET-IN-MESSAGE");
    spy.mockRestore();
  });
});

describe("/api/mcp CORS", () => {
  it("answers preflight for claude.ai and claude.com only", async () => {
    const { route } = await setup();
    for (const origin of ["https://claude.ai", "https://claude.com"]) {
      const res = await route.handle(new Request(URL_MCP, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }));
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    }
    for (const origin of ["https://evil.example", "http://claude.ai", "https://claude.ai.evil.example", "null"]) {
      const res = await route.handle(new Request(URL_MCP, { method: "OPTIONS", headers: { Origin: origin } }));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("adds CORS (and exposes WWW-Authenticate) on real responses for allowed origins only", async () => {
    const { route } = await setup();
    const res = await route.handle(post(INIT, undefined, { Origin: "https://claude.ai" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const bad = await route.handle(post(INIT, GOOD, { Origin: "https://evil.example" }));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
