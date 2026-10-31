import { handleDeepHealth } from "@/lib/cron/handlers";
import { deepHealthDeps } from "@/lib/cron/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/health/deep — read-only per-account check through the normal pipeline. Bearer CRON_SECRET required. */
export const GET = (request: Request) => handleDeepHealth(request, { env: process.env, getDeps: deepHealthDeps });
