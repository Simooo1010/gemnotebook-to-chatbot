// Production wiring for the cron/health routes (server only). Built lazily per request from the cached runtime.
import { getRuntime } from "@/lib/runtime";
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
  };
}

export function deepHealthDeps(): DeepHealthDeps {
  const rt = getRuntime();
  return { listAccounts: () => rt.listAccounts(), listNotebooks: (id, opts) => rt.notebooks.listNotebooks(id, opts) };
}
