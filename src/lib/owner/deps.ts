import { getVault } from "@/lib/vault";
import { sharedLimiter, type OwnerDeps } from "./handlers";

/** Production wiring for the route files. */
export const ownerDeps = (): OwnerDeps => ({ env: process.env, limiter: sharedLimiter, getVault });
