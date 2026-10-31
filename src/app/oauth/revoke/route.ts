import { getOAuthDeps } from "@/lib/oauth";
import { handleRevoke, preflight } from "@/lib/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleRevoke(req, { env: process.env, oauth: getOAuthDeps });
export const OPTIONS = preflight;
