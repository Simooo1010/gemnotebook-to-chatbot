import { handleKill } from "@/lib/owner/handlers";
import { ownerDeps } from "@/lib/owner/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  handleKill(req, (await ctx.params).id, ownerDeps());
