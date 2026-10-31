# Connect Claude to your notebooks

Status: deployed to production and the connector reaches the consent page. **Not yet verified end to end with a real Google account** (import an account, then run the live checks in `SETUP-FOR-OWNER.md`).

## The MCP URL

```
<base>/api/mcp
```

`<base>` is the public HTTPS address of the deployment, the same value as `PUBLIC_BASE_URL` (for example `https://your-project.vercel.app`). Use the production address (preview builds are not functional: no service key, and they are login-protected). Vercel Authentication must be off for the address you use, because OAuth protects `/api/mcp` instead.

## Add it in claude.ai

1. Open claude.ai, then **Settings → Connectors → Add custom connector**.
2. Name: anything (for example "NotebookLM"). URL: `<base>/api/mcp`. Leave any advanced client-id/secret fields empty (the connector registers itself).
3. Press **Add**, then **Connect**. Claude opens the approval page of this app in a browser tab.
4. If asked, sign in with the owner passphrase (the login page of this app). Your browser signs in again here even if you used the vault page earlier: that is by design.
5. The consent screen reads **Allow "Claude" to use NotebookLM?** and shows the app name, the host it returns to (`claude.ai`), what it will be able to do, and the note that it never sees your Google cookies. Press **Approve** (or **Deny**).
6. You land back in Claude. Ask something like "list my notebooks". With exactly one connected Google account the account is implied; with several, Claude asks which one.

If the connector says it needs to reconnect, repeat step 3. Access tokens last 1 hour and are refreshed automatically for 30 days.

## What Claude can do in this step

`accounts_list`, `notebooks_list`, `notebook_create`, `notebook_rename` (only notebooks this connector created), `notebook_get` (with sources), `notebook_summary`. Nothing can be deleted.

## Audio and video overviews (Step 6)

Tools: `studio_audio_create`, `studio_video_create`, `studio_status`, `studio_download_link`. In plain words:

1. Make sure the notebook has at least one source that is **ready** (Claude checks this and tells you if not; sources still importing are skipped).
2. Ask Claude, for example, "make a brief audio overview of this notebook, in Italian" or "make a whiteboard-style video explainer". Audio can be a deep dive, brief, critique or debate, short, default or long. Video can be an explainer or brief, in one of the styles (auto, classic, whiteboard, heritage, paper craft, watercolor, anime, retro print, kawaii) or your own custom style description. Claude answers at once with an id: it does **not** wait.
3. Google builds it in the background. That takes a few minutes, sometimes more than 30. Claude checks with `studio_status` no more often than about every 15 seconds. Status goes queued, then generating, then ready (a file is ready only when `readyMedia` is true), or failed.
4. When it is ready, ask for the link. `studio_download_link` returns an address on this connector's own domain that is valid for 15 minutes by default (up to 60). Open it on your phone or computer to play or save the file (audio is .m4a, video is .mp4). Anyone who has the link can download that one file until it expires, so do not share it; ask Claude for a new one when it runs out. Video seeking on iPhone Safari relies on byte ranges, which the link supports.

Limits: free Google accounts only get a few audio and video overviews per day. This connector also keeps its own daily limit per account (default 2 audio and 2 video per UTC day). When a limit is reached nothing is started and nothing is retried; try again tomorrow. A failed overview is not retried either (starting a new one counts again). If a start request gives an unclear answer, Claude checks `studio_status` before starting another one, so you do not get duplicates.

The link needs `PUBLIC_BASE_URL` and `MASTER_SECRET` (or `OAUTH_SIGNING_KEY`) to be set on the server (see `SETUP-FOR-OWNER.md`). The media address never contains Google cookies or Google file addresses.

## Asking questions with citations (Step 7)

Tool: `chat_ask`. In plain words:

1. Make sure the notebook has at least one source that is **ready** (Claude checks this; if none is ready nothing is sent and Claude tells you what to do).
2. Ask Claude something about the notebook, for example "In my Cats notebook, how long do cats sleep? Cite your sources." Claude sends your question to NotebookLM, which answers **only from the notebook's own sources** (not from the web or general knowledge).
3. The answer comes back with numbers like [1] and [2]. Each number points to a source (its title) and the short passage it came from. You can also tell Claude to use only some sources.
4. To ask a follow-up in the same conversation ("and what about kittens?"), Claude passes along the conversation id from the first answer. Starting a completely fresh conversation is not supported yet.

Limits: free Google accounts only get a limited number of chat questions per day. This connector also keeps its own daily limit per account (default 30 per UTC day). When a limit is reached nothing is sent and nothing is retried; try again tomorrow. If an answer is very long, it is cut and Claude is told so (ask a narrower question). If a request gives an unclear answer, Claude may retry once at most. Your questions and the answers are not stored or logged by this connector; the chat itself shows up in the notebook's chat history in NotebookLM.

## Keeping Google sessions alive (Step 8a)

Google sessions expire if nobody uses them. The route `/api/cron/keepalive` refreshes every **active** account one after another (with the usual pauses, stopping after about 50 seconds and reporting how many accounts it had to skip). It answers only counts and a status per account id: never cookies or names.

It is protected by `CRON_SECRET`: the request must carry `Authorization: Bearer <CRON_SECRET>`. If `CRON_SECRET` is not set on the server the route answers 503 and does nothing. Two callers are set up in the repo:

1. **Vercel Cron (automatic).** `vercel.json` schedules one call per day. Vercel sends the bearer header by itself from the `CRON_SECRET` environment variable. Nothing to do besides setting that variable. (A daily refresh alone is a safety net, not enough to keep a session warm.)
2. **GitHub Actions every 15 minutes (optional, recommended).** The workflow `.github/workflows/keepalive.yml` calls the route with curl. In the GitHub repository open **Settings → Secrets and variables → Actions**: add the **variable** `APP_URL` (your https production address, no trailing slash) and the **secret** `CRON_SECRET` (the same value as on Vercel). While either is empty the job is skipped.

A deeper check is `GET /api/health/deep` (same bearer header). For each active account it does one small read of the notebook list and answers only `ok`, `needs_reauth`, `region_gate`, `drift`, `quota` or `error` per account id. Notebook names are never included. Use it to see whether a session is still alive without opening Claude.

## Revoke access

- One app: sign in at `<base>/vault`, section **Connected apps**, press **Revoke** next to the app.
- Everything: **Revoke all connector access** on the same page.
- Google side: **Revoke all accounts** on the vault page disables every Google account and erases the stored sessions.
- In claude.ai you can also remove the connector under Settings → Connectors; that does not revoke tokens by itself, so use the vault page as well.

## If something fails

Tool errors say what to do. Typical ones: "re-import this account on the vault page" (Google session expired), "daily limit reached" (try tomorrow, UTC), "cooling down" (wait the stated seconds). A 503 from `/api/mcp` means the server's Supabase settings are missing or unreachable.
