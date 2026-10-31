import { handleKeepAlive } from "@/lib/cron/handlers";
import { keepAliveDeps } from "@/lib/cron/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Total sweep budget is ~50 s (see lib/cron/keepalive.ts); leave headroom under the function limit.
export const maxDuration = 60;

const handle = (request: Request) => handleKeepAlive(request, { env: process.env, getDeps: keepAliveDeps });

/** Vercel Cron issues GET; GitHub Actions / pg_cron may use either. Bearer CRON_SECRET required. */
export const GET = handle;
export const POST = handle;
