import { getOAuthDeps } from "@/lib/oauth";
import { handleConsent } from "@/lib/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleConsent(req, { env: process.env, oauth: getOAuthDeps });
