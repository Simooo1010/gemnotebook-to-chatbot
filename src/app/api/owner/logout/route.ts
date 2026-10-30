import { handleLogout } from "@/lib/owner/handlers";
import { ownerDeps } from "@/lib/owner/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleLogout(req, ownerDeps());
