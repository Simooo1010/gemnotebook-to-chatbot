// Request handlers for the cron keep-alive and the deep health check, with injected deps (unit-testable).
// Responses carry counts and per-account ids/statuses only: no cookies, labels, notebook names or error text.
import { authorizeCron } from "./auth";
import { runKeepAliveSweep, type SweepDeps } from "./keepalive";
import { runDeepHealth, type DeepHealthDeps } from "./deep-health";

type Env = Record<string, string | undefined>;
const headers = { "Cache-Control": "no-store" };

export interface CronHandlerDeps<D> {
  env: Env;
  /** Lazy: may throw when storage is not configured (answered as 503 with a generic message). */
  getDeps: () => D;
}

function unavailable(): Response {
  return Response.json({ error: "service not configured" }, { status: 503, headers });
}

export async function handleKeepAlive(request: Request, c: CronHandlerDeps<SweepDeps>): Promise<Response> {
  const denied = authorizeCron(request, c.env);
  if (denied) return denied;
  let deps: SweepDeps;
  try {
    deps = c.getDeps();
  } catch {
    return unavailable();
  }
  try {
    const result = await runKeepAliveSweep(deps);
    // 503 when any account failed (error / needs_reauth) so the scheduled job turns red and the owner is told.
    // Legitimate skips (rotation limiter, quota cooldown, exhausted budget) stay 200. Body = ids and statuses only.
    const failed = result.results.some((r) => r.status === "error" || r.status === "needs_reauth");
    return Response.json(result, { status: failed ? 503 : 200, headers });
  } catch {
    return Response.json({ error: "keep-alive failed" }, { status: 500, headers });
  }
}

export async function handleDeepHealth(request: Request, c: CronHandlerDeps<DeepHealthDeps>): Promise<Response> {
  const denied = authorizeCron(request, c.env);
  if (denied) return denied;
  let deps: DeepHealthDeps;
  try {
    deps = c.getDeps();
  } catch {
    return unavailable();
  }
  try {
    const result = await runDeepHealth(deps);
    // Same rule as keep-alive: a failing account must not hide behind a 200 ("quota" is a legitimate back-off, not a failure).
    const failed = result.accounts.some((a) => a.status !== "ok" && a.status !== "quota");
    return Response.json(result, { status: failed ? 503 : 200, headers });
  } catch {
    return Response.json({ error: "health check failed" }, { status: 500, headers });
  }
}
