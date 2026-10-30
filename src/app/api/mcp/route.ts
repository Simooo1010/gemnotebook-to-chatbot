import { createMcpRoute } from "@/lib/mcp/route";
import { getOAuthDeps } from "@/lib/oauth";
import { getRuntime } from "@/lib/runtime";
import pkg from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = createMcpRoute({ env: process.env, oauth: getOAuthDeps, runtime: getRuntime, serverVersion: pkg.version });

export const GET = route.handle;
export const POST = route.handle;
export const DELETE = route.handle;
export const OPTIONS = route.options;
