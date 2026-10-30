# Connect Claude to your notebooks

Status: Step 4 code is complete but **not yet verified against a real claude.ai connector** (needs a deploy with the owner's environment variables first, see `SETUP-FOR-OWNER.md`).

## The MCP URL

```
<base>/api/mcp
```

`<base>` is the public HTTPS address of the deployment, the same value as `PUBLIC_BASE_URL` (for example `https://your-project.vercel.app`). For a preview build use that preview's address. Vercel Authentication must be off for the address you use, because OAuth protects `/api/mcp` instead.

## Add it in claude.ai

1. Open claude.ai, then **Settings → Connectors → Add custom connector**.
2. Name: anything (for example "NotebookLM"). URL: `<base>/api/mcp`. Leave any advanced client-id/secret fields empty (the connector registers itself).
3. Press **Add**, then **Connect**. Claude opens the approval page of this app in a browser tab.
4. If asked, sign in with the owner passphrase (the login page of this app). Your browser signs in again here even if you used the vault page earlier: that is by design.
5. The consent screen reads **Allow "Claude" to use NotebookLM?** and shows the app name, the host it returns to (`claude.ai`), what it will be able to do, and the note that it never sees your Google cookies. Press **Approve** (or **Deny**).
6. You land back in Claude. Ask something like "list my notebooks". With exactly one connected Google account the account is implied; with several, Claude asks which one.

If the connector says it needs to reconnect, repeat step 3. Access tokens last 1 hour and are refreshed automatically for 30 days.

## What Claude can do in this step

`accounts_list`, `notebooks_list`, `notebook_create`, `notebook_rename` (only notebooks this connector created), `notebook_get` (with sources), `notebook_summary`. Sources, chat and audio/video overviews come in later steps. Nothing can be deleted.

## Revoke access

- One app: sign in at `<base>/vault`, section **Connected apps**, press **Revoke** next to the app.
- Everything: **Revoke all connector access** on the same page.
- Google side: **Revoke all accounts** on the vault page disables every Google account and erases the stored sessions.
- In claude.ai you can also remove the connector under Settings → Connectors; that does not revoke tokens by itself, so use the vault page as well.

## If something fails

Tool errors say what to do. Typical ones: "re-import this account on the vault page" (Google session expired), "daily limit reached" (try tomorrow, UTC), "cooling down" (wait the stated seconds). A 503 from `/api/mcp` means the server's Supabase settings are missing or unreachable.
