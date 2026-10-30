import { getOAuthDeps } from "@/lib/oauth";
import { handleOwnerRevokeClient } from "@/lib/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleOwnerRevokeClient(req, id, { env: process.env, oauth: getOAuthDeps });
}
