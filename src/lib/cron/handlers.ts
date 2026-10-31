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
  /** Optional housekeeping (prune_expired). Best effort: errors are swallowed and never affect the keep-alive result. */
  prune?: () => Promise<unknown>;
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
    return Response.json(await runKeepAliveSweep(deps), { headers });
  } catch {
    return Response.json({ error: "keep-alive failed" }, { status: 500, headers });
  } finally {
    // Runs after the sweep whatever its outcome; its failure is invisible to the caller.
    await Promise.resolve()
      .then(() => c.prune?.())
      .catch(() => undefined);
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
    return Response.json(await runDeepHealth(deps), { headers });
  } catch {
    return Response.json({ error: "health check failed" }, { status: 500, headers });
  }
}
