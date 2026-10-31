import { createMcpRoute } from "@/lib/mcp/route";
import { getOAuthDeps } from "@/lib/oauth";
import { getRuntime } from "@/lib/runtime";
import pkg from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Explicit function limit: chat_ask streams for up to 120 s and a media download can run for minutes.
// Needs Vercel Fluid Compute (Hobby maximum 300 s); see docs/PROGRESS.md.
export const maxDuration = 300;

const route = createMcpRoute({ env: process.env, oauth: getOAuthDeps, runtime: getRuntime, serverVersion: pkg.version });

export const GET = route.handle;
export const POST = route.handle;
export const DELETE = route.handle;
export const OPTIONS = route.options;
