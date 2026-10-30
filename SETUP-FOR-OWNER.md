# Setup — what only you can do

Status: 0 of 9 done.

> **Everything on this page is done in ONE batch at the very end** (owner decision 2026-10-30). Until then nothing here blocks Claude; it builds against fixtures and adapters and will say clearly what is not yet verified live.

## Accounts and access
- [ ] Confirm the GitHub connection to Claude covers `Simooo1010/gemnotebook-to-chatbot` (already attached to this session).
- [ ] Vercel: import the `gemnotebook-to-chatbot` repo as a project (Claude can do this through the Vercel connector; tell Claude if it is refused).
- [ ] Supabase: pick (or create) the project for the vault and tell Claude which one. Claude creates the tables.

## Secrets (environment variables)
Never paste secret values into chat. Claude generates the random ones and tells you only the variable names.
- [ ] Vercel → Settings → Environment Variables (Preview + Production): `VAULT_ENCRYPTION_KEY` — random 32-byte key for the cookie vault.
- [ ] Vercel env: `OWNER_PASSPHRASE_HASH` — hash of the passphrase that protects the login/vault page and the connector approval screen.
- [ ] Vercel env: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — server side only.
- [ ] Claude cloud environment (only for the real-data run, gate 2): a Google session for a test account, imported through the vault page, never pasted in chat.

## Connections to outside systems
- [ ] In claude.ai → Settings → Connectors → Add custom connector → paste the MCP URL Claude gives you at hand-off.

## On your device
- [ ] Install a cookie-export extension (e.g. Cookie-Editor) in a desktop browser. For each Google account: open a **private window**, sign in at notebook.google.com, export the cookies as JSON, paste them on the vault page, then **close the private window without signing out**. No password is ever typed or stored.
