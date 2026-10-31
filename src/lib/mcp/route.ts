// /api/mcp request handling with injected deps (unit-testable). Streamable HTTP via mcp-handler, bearer auth in front.
// Never logs tokens; the OAuth store only ever sees hashes.
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { corsHeaders, preflight } from "@/lib/oauth/http";
import type { OAuthDeps } from "@/lib/oauth/deps";
import { resolveBaseUrl } from "@/lib/oauth/metadata";
import { SCOPE } from "@/lib/oauth/store";
import { verifyAccessToken } from "@/lib/oauth/verify";
import type { ToolRuntime } from "@/lib/runtime";
import { registerTools } from "@/lib/tools";

type Env = Record<string, string | undefined>;

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/api/mcp";

export interface McpRouteDeps {
  env: Env;
  /** Lazy: may throw when OAuth storage is not configured (→ 503). */
  oauth: () => OAuthDeps;
  /** Lazy: tools call this per request; a throw becomes a tool error, never a crash. */
  runtime: () => ToolRuntime;
  serverVersion?: string;
}

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** RFC 6750 §3.1: when the request carried no credentials the challenge must not carry an error code. */
export function stripChallengeError(challenge: string): string {
  const m = /^(\S+)\s+(.*)$/s.exec(challenge);
  if (!m) return challenge;
  const params = (m[2] ?? "").match(/[A-Za-z_][\w-]*="[^"]*"/g) ?? [];
  const kept = params.filter((p) => !/^error(_description|_uri)?=/.test(p));
  return kept.length ? `${m[1]} ${kept.join(", ")}` : (m[1] ?? challenge);
}

function withHeaders(request: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...NO_STORE, ...corsHeaders(request), "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id" })) headers.set(k, v);
  const challenge = headers.get("www-authenticate");
  if (res.status === 401 && challenge && !request.headers.get("authorization")) headers.set("WWW-Authenticate", stripChallengeError(challenge));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The server is stateless (no sessions, GET answers 405), so nothing can ever send `notifications/tools/list_changed`.
 * The SDK advertises `tools.listChanged: true` unconditionally when a tool is registered and offers no option for it
 * (mcp-handler only forwards `capabilities` that the SDK then merges), so the flag is cleared on the underlying server's
 * capability object. Defensive: a changed SDK shape leaves the default in place (route.test.ts pins the result).
 */
export function disableListChanged(server: unknown): void {
  const caps = (server as { server?: { _capabilities?: { tools?: { listChanged?: boolean } } } }).server?._capabilities;
  if (caps?.tools) caps.tools.listChanged = false;
}

export function createMcpRoute(d: McpRouteDeps) {
  const inner = createMcpHandler((server) => {
    registerTools(server, d.runtime);
    disableListChanged(server);
  }, {
    serverInfo: { name: "notebooklm-connector", version: d.serverVersion ?? "0.1.0" },
  });

  async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return preflight(request);

    let oauth: OAuthDeps;
    try {
      oauth = d.oauth();
    } catch {
      return withHeaders(request, Response.json({ error: "temporarily_unavailable", error_description: "Storage unavailable." }, { status: 503 }));
    }

    let storageFailed = false;
    const guarded = withMcpAuth(
      inner,
      async (_req, bearer) => {
        let grant;
        try {
          grant = await verifyAccessToken(bearer, oauth);
        } catch {
          storageFailed = true;
          return undefined;
        }
        if (!grant || !bearer) return undefined;
        return { token: bearer, clientId: grant.clientId, scopes: grant.scope.split(" ").filter(Boolean) };
      },
      {
        required: true,
        requiredScopes: [SCOPE],
        resourceMetadataPath: PROTECTED_RESOURCE_PATH,
        resourceUrl: resolveBaseUrl(d.env.PUBLIC_BASE_URL, request.url),
      },
    );

    const res = await guarded(request);
    if (storageFailed) {
      return withHeaders(request, Response.json({ error: "temporarily_unavailable", error_description: "Storage unavailable." }, { status: 503 }));
    }
    return withHeaders(request, res);
  }

  return { handle, options: preflight };
}
