# NotebookLM connector

A small remote MCP server (Next.js on Vercel) that lets Claude use Google NotebookLM: list and create notebooks, add sources, ask questions with citations, and start native audio and video overviews. It works through your own logged-in Google sessions, so there is no paid API and no extra cost.

## How it works, in 10 lines
1. You add one custom connector in claude.ai: `<your address>/api/mcp`.
2. Claude signs in to this app with OAuth 2.1 (PKCE). You approve it once, behind your owner passphrase.
3. You import each Google account once on the vault page, by pasting a cookie export made in a private window. No password is typed or stored.
4. The cookies are encrypted (AES-256-GCM) and stored in Supabase. The key lives only in environment variables.
5. When Claude calls a tool, the server decrypts the session in memory and talks to NotebookLM's internal web endpoints, one request at a time per account, with human-like pauses.
6. Audio and video overviews take minutes: Claude starts one, then checks its status.
7. Downloads are short-lived signed links on this app's own domain; the file is streamed from Google, never exposed with cookies.
8. A scheduled keep-alive refreshes every session so it does not expire.
9. A deep health check tells you per account whether the session is still alive.
10. Nothing is ever deleted in NotebookLM; the app only adds.

## Safety model (summary of `docs/SPEC.md` §4)
This is reverse-engineered access, so Google can change it or flag a session at any time. The design limits the damage:
- **Flagging:** one request at a time per account, 1.5 to 4 s gaps, polling no faster than every 15 s, no automatic retry of writes, daily caps per account (audio 2, video 2, chat 30).
- **Stolen cookies:** encrypted at rest, decrypted per call in memory only, never logged, never returned by a tool, never sent to the browser. Row-level security on, service key server side only.
- **Compromised connector token:** short-lived access tokens, owner passphrase gates approval, per-account kill switch and revoke-all on the vault page. The login is rate-limited persistently and fails closed.
- **Prompt injection through sources:** tool results are plain data; no tool reads cookies or changes settings; writes are limited to what this app created; no deletes.
- **Protocol changes:** errors are classified (drift, auth, quota, region gate) and reported clearly; nothing loops.
- **Duplicates on timeouts:** writes are never auto-retried; after an unclear failure the app re-reads to reconcile.

## Docs
- Setup (owner, phone-first): [`SETUP-FOR-OWNER.md`](SETUP-FOR-OWNER.md)
- Connecting Claude, keep-alive and health checks: [`docs/CONNECT.md`](docs/CONNECT.md)
- Product spec: [`docs/SPEC.md`](docs/SPEC.md) · protocol notes: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Working method and progress: [`docs/WORKFLOW.md`](docs/WORKFLOW.md), [`docs/PROGRESS.md`](docs/PROGRESS.md)
- Rules for contributors and Claude: [`CLAUDE.md`](CLAUDE.md)

## Develop
`npm run lint` · `npm test` · `npm run build`. Environment variable names are in `.env.example` (no values).
