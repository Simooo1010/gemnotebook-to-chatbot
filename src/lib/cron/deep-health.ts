// Deep health: one read-only notebooks list (limit 1) per ACTIVE account, through the normal pipeline (throttle, tokens, decoder).
// Reports a status per account id only. Never returns notebook names, ids, cookies or error text.
import { AccountNeedsReauthError, CooldownActiveError, DailyCapReachedError, HttpStatusError, RegionGateError, SignedOutError, CookieMismatchError } from "@/lib/google/errors";
import { RpcAuthError, RpcDriftError, RpcQuotaError } from "@/lib/rpc/errors";
import type { Account } from "@/lib/vault/storage";

export type DeepStatus = "ok" | "needs_reauth" | "region_gate" | "drift" | "quota" | "error";

export interface DeepHealthDeps {
  listAccounts(): Promise<Account[]>;
  /** Must go through the normal pipeline. Only the success/failure matters; the result is discarded. */
  listNotebooks(accountId: string, opts: { limit: number }): Promise<unknown>;
}

export function classifyHealthError(e: unknown): DeepStatus {
  if (e instanceof AccountNeedsReauthError || e instanceof SignedOutError || e instanceof CookieMismatchError || e instanceof RpcAuthError) {
    return "needs_reauth";
  }
  if (e instanceof RegionGateError) return "region_gate";
  if (e instanceof RpcDriftError) return "drift";
  if (e instanceof RpcQuotaError || e instanceof CooldownActiveError || e instanceof DailyCapReachedError) return "quota";
  if (e instanceof HttpStatusError && e.status === 429) return "quota";
  return "error";
}

export async function runDeepHealth(d: DeepHealthDeps): Promise<{ accounts: { id: string; status: DeepStatus }[] }> {
  const active = (await d.listAccounts()).filter((a) => a.status === "active");
  const accounts: { id: string; status: DeepStatus }[] = [];
  for (const a of active) {
    // Sequential: the throttle serialises per account anyway, and we never burst across accounts.
    try {
      await d.listNotebooks(a.id, { limit: 1 });
      accounts.push({ id: a.id, status: "ok" });
    } catch (e) {
      accounts.push({ id: a.id, status: classifyHealthError(e) });
    }
  }
  return { accounts };
}
