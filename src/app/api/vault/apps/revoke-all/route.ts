import { getOAuthDeps } from "@/lib/oauth";
import { handleOwnerRevokeAll } from "@/lib/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleOwnerRevokeAll(req, { env: process.env, oauth: getOAuthDeps });
