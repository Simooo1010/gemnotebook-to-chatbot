import { handleMediaRequest } from "@/lib/notebooklm/media-download";
import { deriveMediaKey } from "@/lib/notebooklm/media-link";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Explicit function limit: chat_ask streams for up to 120 s and a media download can run for minutes.
// Needs Vercel Fluid Compute (Hobby maximum 300 s); see docs/PROGRESS.md.
export const maxDuration = 300;

/** GET /api/media/<token> — streams a generated audio/video overview. The signed token is the only credential. */
export const GET = async (req: Request, ctx: { params: Promise<{ token: string }> }) =>
  handleMediaRequest(req, (await ctx.params).token, {
    key: () => deriveMediaKey(process.env),
    downloader: () => getRuntime().media,
  });
