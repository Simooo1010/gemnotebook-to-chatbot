// OAuth store factory: Supabase when configured; in-memory only outside production; else fail closed.
import { createServiceDb } from "@/lib/vault/supabase";
import { defaultRandom } from "./crypto";
import type { OAuthDeps } from "./deps";
import { createMemoryStore, type OAuthStore } from "./store";
import { createSupabaseStore } from "./supabase";

type Env = Record<string, string | undefined>;
const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

export function createOAuthStoreFromEnv(env: Env): OAuthStore {
  if (has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY)) return createSupabaseStore(createServiceDb(env));
  if (env.NODE_ENV === "production") throw new Error("oauth storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createMemoryStore();
}

const g = globalThis as unknown as { __oauthStore?: OAuthStore };

/** Production wiring. Throws when storage is not configured in production. */
export function getOAuthDeps(): OAuthDeps {
  const store = (g.__oauthStore ??= createOAuthStoreFromEnv(process.env));
  return { store, now: Date.now, random: defaultRandom };
}
