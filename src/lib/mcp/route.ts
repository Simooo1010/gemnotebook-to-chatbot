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

function withHeaders(request: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...NO_STORE, ...corsHeaders(request), "Access-Control-Expose-Headers": "WWW-Authenticate" })) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function createMcpRoute(d: McpRouteDeps) {
  const inner = createMcpHandler((server) => registerTools(server, d.runtime), {
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
