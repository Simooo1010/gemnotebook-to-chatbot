import { handleMediaRequest } from "@/lib/notebooklm/media-download";
import { deriveMediaKey } from "@/lib/notebooklm/media-link";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/media/<token> — streams a generated audio/video overview. The signed token is the only credential. */
export const GET = async (req: Request, ctx: { params: Promise<{ token: string }> }) =>
  handleMediaRequest(req, (await ctx.params).token, {
    key: () => deriveMediaKey(process.env),
    downloader: () => getRuntime().media,
  });
