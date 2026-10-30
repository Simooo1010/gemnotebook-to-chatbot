import { handleMetadata, preflight } from "@/lib/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleMetadata("server", req, process.env);
export const OPTIONS = preflight;
