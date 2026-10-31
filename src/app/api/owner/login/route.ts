import { handleLogin } from "@/lib/owner/handlers";
import { ownerDeps } from "@/lib/owner/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleLogin(req, ownerDeps());
