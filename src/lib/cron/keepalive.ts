// Keep-alive sweep: rotate cookies for every ACTIVE account, one at a time, within a time budget. Pure composition: all I/O injected.
// The result carries account ids and statuses only (never cookies, labels or error text).
import { CooldownActiveError } from "@/lib/google/errors";
import { keepAliveAccount, type KeepAliveVault, type RotationLimiter } from "@/lib/google/keepalive";
import type { FetchLike } from "@/lib/google/http";
import { MAX_GAP_MS, MIN_GAP_MS, type Throttle } from "@/lib/google/throttle";
import type { Account, AccountRepo } from "@/lib/vault/storage";

export const DEFAULT_BUDGET_MS = 50_000;
/** Below this much remaining budget we do not start another account. */
const MIN_REMAINING_MS = 3_000;
const MAX_ROTATE_TIMEOUT_MS = 15_000;

export type SweepStatus = "rotated" | "skipped" | "needs_reauth" | "error" | "cooldown";

export interface SweepResult {
  results: { id: string; status: SweepStatus }[];
  processed: number;
  /** Active accounts not handled because the time budget ran out. */
  skipped: number;
  budgetExhausted: boolean;
}

export interface SweepDeps {
  vault: KeepAliveVault & { listAccounts(): Promise<Account[]> };
  accounts: Pick<AccountRepo, "setStatus">;
  fetch: FetchLike;
  limiter: RotationLimiter;
  throttle: Pick<Throttle, "schedule">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0,1). */
  random?: () => number;
  budgetMs?: number;
}

export async function runKeepAliveSweep(d: SweepDeps): Promise<SweepResult> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = d.random ?? Math.random;
  const started = now();
  const deadline = started + (d.budgetMs ?? DEFAULT_BUDGET_MS);

  const active = (await d.vault.listAccounts()).filter((a) => a.status === "active");
  const results: SweepResult["results"] = [];
  for (const [i, a] of active.entries()) {
    if (i > 0) {
      // Same human-like gap as between RPCs, but never sleep past the budget.
      const gap = MIN_GAP_MS + Math.floor(random() * (MAX_GAP_MS - MIN_GAP_MS));
      if (now() + gap >= deadline) break;
      await sleep(gap);
    }
    const remaining = deadline - now();
    if (remaining < MIN_REMAINING_MS) break;
    let status: SweepStatus;
    try {
      // Through the account's throttle, so it never overlaps a live tool call for the same account.
      const outcome = await d.throttle.schedule(a.id, () =>
        keepAliveAccount(d.vault, a.id, {
          fetch: d.fetch,
          accounts: d.accounts,
          limiter: d.limiter,
          now,
          timeoutMs: Math.min(MAX_ROTATE_TIMEOUT_MS, remaining - 1_000),
        }),
      );
      status = outcome;
    } catch (e) {
      status = e instanceof CooldownActiveError ? "cooldown" : "error";
    }
    results.push({ id: a.id, status });
  }
  const skipped = active.length - results.length;
  return { results, processed: results.length, skipped, budgetExhausted: skipped > 0 };
}
