// Bearer CRON_SECRET gate for cron and deep-health routes. Constant-time compare (bearerMatches); fails closed.
import { bearerMatches } from "@/lib/google/probe";

const headers = { "Cache-Control": "no-store" };

/** Null when the request is authorised; otherwise the Response to send (503 when CRON_SECRET is unset, 401 on mismatch). */
export function authorizeCron(request: Request, env: Record<string, string | undefined>): Response | null {
  const secret = env.CRON_SECRET;
  if (!secret || secret.trim() === "") return Response.json({ error: "not configured" }, { status: 503, headers });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  return null;
}
