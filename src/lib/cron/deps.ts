// Production wiring for the cron/health routes (server only). Built lazily per request from the cached runtime.
import { createServiceDb } from "@/lib/vault/supabase";
import { getRuntime, resolveNotebookBaseUrl } from "@/lib/runtime";
import type { DeepHealthDeps } from "./deep-health";
import type { SweepDeps } from "./keepalive";

export function keepAliveDeps(): SweepDeps {
  const rt = getRuntime();
  return {
    vault: rt.vault,
    accounts: { setStatus: (id, status) => (status === "needs_reauth" ? rt.vault.markNeedsReauth(id) : Promise.resolve()) },
    fetch: rt.fetch,
    limiter: rt.rotationLimiter,
    throttle: rt.throttle,
    probeBase: resolveNotebookBaseUrl(process.env),
  };
}

export function deepHealthDeps(): DeepHealthDeps {
  const rt = getRuntime();
  return { listAccounts: () => rt.listAccounts(), listNotebooks: (id, opts) => rt.notebooks.listNotebooks(id, opts) };
}

/** Daily clean-up of expired OAuth rows, old audit/login rows (SQL function public.prune_expired, service role only). No-op without Supabase. */
export async function pruneExpired(): Promise<unknown> {
  const env = process.env;
  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return undefined;
  return createServiceDb(env).rpc?.("prune_expired");
}
