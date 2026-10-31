import { getLoginLimiter } from "@/lib/auth/login-limiter";
import { getVault } from "@/lib/vault";
import type { OwnerDeps } from "./handlers";

/** Production wiring for the route files. The limiter is persistent (Supabase) and fails closed in production. */
export const ownerDeps = (): OwnerDeps => ({ env: process.env, limiter: getLoginLimiter(), getVault });
