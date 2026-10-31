# QA report — gates 4 (walkthrough) and 5 (visual), sandbox run

Run: `docs/qa/walkthrough.mjs` against the real app in `next dev` with in-memory adapters and synthetic env values (gitignored `.env.local`).
Final result on the release tip: **137/137 checks passed**, 40 screenshots (10 states × light/dark × phone 390×844 / desktop 1280×800) in `docs/qa/screenshots/`, machine-readable results in `docs/qa/results.json`.
Re-run: write a gitignored `.env.local` (OWNER_PASSPHRASE, MASTER_SECRET ≥ 32 chars, PUBLIC_BASE_URL=http://localhost:3000, CRON_SECRET), start a FRESH `npx next dev -p 3000` (state is in memory), then `node docs/qa/walkthrough.mjs`.

| Step | What | Result |
|---|---|---|
| 1 | Home and `/api/health` (booleans only) | pass |
| 2 | Login gate: signed-out redirect, generic wrong-passphrase error | pass |
| 3 | Vault: malformed / incomplete / valid synthetic cookie import, kill (confirm), revoke-all (confirm), pasted JSON never echoed | pass |
| 4 | OAuth + MCP: DCR, PKCE S256, consent approve/deny, token exchange, 17 tools listed (none destructive), `accounts_list` without cookie data, 401 + `WWW-Authenticate` without token, code replay and refresh-token reuse revoke the family | pass |
| 5 | Cron + deep health: 401 without/with wrong bearer, statuses only with the secret, fail closed when Google is unreachable | pass |
| 6 | Screenshots: no horizontal scroll at phone width, contrast ≥ 4.5:1 in every state, visual review | pass |

## Defects found
- **D1 (fixed):** consent Approve/Deny returned 403 in a real browser because the site-wide `Referrer-Policy: no-referrer` makes Chromium send `Origin: null` on the form POST. Fixed with `referrer: same-origin` on the authorize page + test.
- **D2 (fixed):** error text looked like help text; now danger colour with spacing.
- **D3 (fixed):** missing-cookie import returned a generic 500 when the typed error crossed a module-graph boundary; errors are now recognised structurally (`isJarError`, `isVaultError`) + tests.
- **Design risk (fixed):** a bare 401/403 during keep-alive or token refresh no longer flags `needs_reauth`; only a sign-in redirect or a confirming homepage read (signed_out / cookie_mismatch) does.

## NOT verified (needs the owner's final run)
Real Google (signed-in RPC, cookie rotation, chat, audio/video, media download, quota behaviour) · real Supabase (migrations 0001–0003 unapplied; production-mode memory refusal only built) · real device (iPhone/Safari `Origin` behaviour on the consent POST, byte-range video seeking, Claude phone app) · real claude.ai handshake · Vercel deployed headers/CSP, cron, GitHub Actions keep-alive · screen reader and keyboard-only passes.
