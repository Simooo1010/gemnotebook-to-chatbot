# Final manual run — what only you can do

Written for a phone. Do the steps in order. Never paste a secret into chat: you paste secrets only into the Vercel or GitHub settings screens.

## Already done by Claude (2026-10-31)
- Release v1 merged to `main`; Vercel builds production from it.
- Supabase project `notebook-connector`: the three migrations are applied and checked (9 tables, row-level security on all, no policies, no access for the public API roles).
- Vercel variables created: `SUPABASE_URL` (Production + Preview) and `PUBLIC_BASE_URL` = `https://gemnotebook-to-chatbot.vercel.app` (Production only).

## b. Vercel environment variables (only these four are left, by you)
I deliberately did not create these: they are secrets, and creating them would put their values into this chat.
Vercel → your project → Settings → Environment Variables → Add. Choose **Production only** (untick Preview and Development) and mark each one **Sensitive**. Preview deployments are not functional on purpose: they have no service key and are protected by Vercel login, so all testing happens on the production address.

| Name | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → project `notebook-connector` → Project Settings → API → **service_role** key (not anon) |
| `OWNER_PASSPHRASE` | a long passphrase you will remember |
| `MASTER_SECRET` | one random string of **at least 32 characters** (your password manager can generate it). It derives the vault and signing keys. **Keep a copy**: losing it makes stored sessions unreadable |
| `CRON_SECRET` | any random string. Keep a copy if you do the optional keep-alive in step g |

Do **not** add `SUPABASE_URL` or `PUBLIC_BASE_URL`: they already exist. You do not need `VAULT_ENCRYPTION_KEY`, `VAULT_KEY_VERSION` or `OAUTH_SIGNING_KEY` (they would still win if you set them).

## c. Redeploy production
Vercel → Deployments → the latest production deployment → ⋯ → **Redeploy**. Then open `<base>/api/health` in the browser: it should say `"ok": true`, and `keys` should show `vault: true, signing: true`.

## d. Sign in and import your Google account
1. Open `<base>/login` and sign in with your passphrase.
2. On a computer: open a **private window**, sign in at notebook.google.com, export the cookies as JSON with a cookie-export extension (for example Cookie-Editor), then **close the private window without signing out**.
3. On `<base>/vault`: give the account a short name, paste the JSON, press import. The account shows as **active**.

## e. Add the connector in claude.ai
Settings → Connectors → Add custom connector. URL: `<base>/api/mcp`. Leave advanced fields empty. Press Add, then Connect, sign in if asked, and press **Approve**.

## f. Live checks (ask Claude one by one)
1. "List my notebooks" → your real notebook titles appear, matching the NotebookLM app.
2. "Create a notebook called Connector test" → it appears in NotebookLM.
3. "Add this URL as a source: https://en.wikipedia.org/wiki/Cat" → the source shows in the notebook and becomes ready.
4. "Ask the notebook how long cats sleep, with sources" → an answer with numbered citations that name the source.
5. "Make a brief audio overview" → Claude answers at once with an id; later status goes generating, then ready; it also appears in NotebookLM.
6. "Make a video overview" → same, takes longer.
7. "Give me the download link for the audio" → open the link on your phone: the audio plays. Try the video link too (seeking should work).

If a step fails, tell Claude the exact message. Do not retry it many times in a row.

## g. Optional but recommended: 15-minute keep-alive
Google sessions expire if unused. GitHub repository → Settings → Secrets and variables → Actions:
- **Variables** tab: add `APP_URL` = your production address (no trailing slash).
- **Secrets** tab: add `CRON_SECRET` = the same value as on Vercel.
Then Actions → keepalive → Run workflow once to test. Without this, only the daily Vercel job refreshes sessions.
- The workflow needs the repository **variable** `APP_URL` and the repository **secret** `CRON_SECRET`; while either is empty the job is skipped.
- The workflow only appears and only runs on the repository's **default branch** (Settings → General → Default branch must be `main`).
- The run turns red (and GitHub emails you) when any account needs a new import; open the vault page to see which.
- GitHub **disables scheduled workflows in public repositories after 60 days without repository activity**. If the keep-alive stops, open Actions → keepalive → Enable workflow (any commit also resets the timer).

## h. Confirm one dependency
Confirm that `@modelcontextprotocol/server` 2.4.0 may stay installed. It is not on the approved list, but `mcp-handler` requires it as a peer dependency (our code never imports it directly). Tell Claude yes or no.
