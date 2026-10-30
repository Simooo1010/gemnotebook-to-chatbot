import { handleImport, handleListAccounts } from "@/lib/owner/handlers";
import { ownerDeps } from "@/lib/owner/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleListAccounts(req, ownerDeps());
export const POST = (req: Request) => handleImport(req, ownerDeps());
