import { bearerMatches, runGoogleProbe } from "@/lib/google/probe";
import type { FetchLike } from "@/lib/google/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** GET /api/probe/google — unauthenticated reachability check of NotebookLM from this server's IP. Cron-secret protected. */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === "") return Response.json({ error: "probe not configured" }, { status: 503, headers });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  const result = await runGoogleProbe({
    fetch: fetch as unknown as FetchLike,
    base: process.env.NOTEBOOKLM_BASE_URL,
    signal: AbortSignal.timeout(15_000),
  });
  return Response.json(result, { headers });
}
