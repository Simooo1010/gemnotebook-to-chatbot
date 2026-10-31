import { buildHealthReport } from "@/lib/health";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(buildHealthReport(process.env, pkg.version), {
    headers: { "Cache-Control": "no-store" },
  });
}
