# SPEC — NotebookLM Connector (MCP)

Status: **v1 APPROVED 2026-10-30 by Simooo1010.** Protocol details live in `docs/PROTOCOL.md` (research of three open-source clients, read 2026-10-30). The product is now branded "Gemini Notebook" (since 2026-07-16); the wire protocol is unchanged. Call it NotebookLM in code and docs.

## 1. Goal (required)
Simooo1010 uses Claude (web, phone, desktop) and adds one custom connector. From then on Claude can work with NotebookLM notebooks — list and create them, add sources, ask questions with citations, and start **native audio and video overviews** that are generated inside NotebookLM on the owner's own account quota (no paid API, no extra cost). Any number of Google accounts can be connected; each is isolated.

"Done" for v1 (by 2026-10-31 22:00): the MCP URL is deployed to production, added as a connector in claude.ai, and Claude can, on a real account: list notebooks → create one → add a URL source → ask a cited question → start an audio overview and a video overview → poll status → get a working download link.

Out of v1: other Studio outputs (reports, slides, infographics, quizzes, flashcards, mind maps, data tables), any delete, file-upload sources (Scotty flow unverified, stretch Step 9), the Enterprise API, cinematic video (needs Ultra).

## 2. Data (required)
Source: NotebookLM web backend (internal `batchexecute` RPC, no public API). Names are copied exactly from `docs/PROTOCOL.md` (cross-read in three clients). **Anything marked UNVERIFIED there must be proven by the real-data run (gate 2) before it is relied on. If live behavior differs: stop and report, never guess.**

Transport: `POST {base}/_/LabsTailwindUi/data/batchexecute?rpcids=…&source-path=…&f.sid=…&hl=en&rt=c`; `{base}` is configurable (default `https://notebook.google.com`, `notebooklm.google.com` redirects to it). Body `f.req=…&at=<SNlM0e>`. Page tokens from `GET {base}/`: `SNlM0e` (at), `FdrFJe` (f.sid), `cfb2h` (bl). Keep-alive: `POST https://accounts.google.com/RotateCookies` body `[000,"-0000000000000000000"]`. Chat uses `…/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`.

| Capability | RPC id | source-path | App reads | App writes |
|---|---|---|---|---|
| List notebooks | `wXbhsf` | `/` | yes | no |
| Create notebook | `CCqFvf` | `/` | yes | **yes** |
| Rename notebook | `s0tc2d` | `/notebook/{id}` | yes | **yes** (only notebooks it created) |
| Get notebook + sources | `rLM1Ne` | `/notebook/{id}` | yes | no |
| Notebook summary | `VfAZjd` | `/notebook/{id}` | yes | no |
| Add source (URL / YouTube / text / Drive) | `izAoDd` (fallback `ozz5Z` for URL) | `/notebook/{id}` | yes | **yes** |
| Source full text | `hizoJc` | `/notebook/{id}` | yes | no |
| Source guide | `tr032e` | `/notebook/{id}` | yes | no |
| Chat ask (streamed) | `GenerateFreeFormStreamed`; conversation id via `hPTbtc` | — | yes | **yes** (a chat turn) |
| Create Studio artifact | `R7cb6c` (type 1 audio, type 3 video) | `/notebook/{id}` | yes | **yes** |
| List/poll artifacts | `gArtLc` | `/notebook/{id}` | yes | no |
| Account tier | `ZwVcOc` (`limits[4]`) | `/` | yes | no |
| Quota summary (if enabled) | `EylDcb` (gated by `SatQRc` field 5.7) | `/` | yes | no |

Exact option values (copied from PROTOCOL §3.4):
- Audio `content[6] = [null,[focusPrompt|null, lengthCode, null, ids2, language, null, formatCode]]`; format 1 deep dive, 2 brief, 3 critique, 4 debate; length 1 short, 2 default, 3 long.
- Video `content[8] = [null,null,[ids2, language, focusPrompt, null, formatCode, styleCode, stylePrompt?]]`; format 1 explainer, 2 brief (4 short and 3 cinematic are out of v1); style 1 auto, 2 classic, 3 whiteboard, 4 heritage, 5 paper-craft, 6 watercolor, 7 anime, 8 retro-print, 9 kawaii (PY live-captured table; custom = `null` + prompt as 7th element). Options block `CA = [2,null,null,[1,null×9,[1]],[[1,4,8,2,3,6]]]` is mandatory for video.
- Artifact status `row[4]`: 0 unknown, 1 initialized, 2 processing, 3 ready, 4 failed. Treat 1+2 as "not done", 3 as done only when the media URL is populated. Audio URL at `row[6][5]` (mime `audio/mp4`), video URL at `row[8][4]` (kind 4, `video/mp4`).
- Source status `row[3][1]`: 1 processing, 2 ready, 3 error, 5 preparing.

Own tables (Supabase, server-side only, RLS on with no public policies): `accounts` (id, label, email-hash, status, created), `sessions` (account id, AES-256-GCM ciphertext + nonce + key version, rotated-at), `oauth_clients`, `oauth_grants`, `audit_log` (account, tool, rpc id, outcome, time — **no bodies, no cookies**), `usage_counters` (per account per day), `created_objects` (notebook ids and artifact ids this app created — the write allow-list).

## 3. Architecture and tools
- **Next.js (App Router, TS strict) on Vercel.** `/api/mcp` = Streamable HTTP MCP (`mcp-handler`); OAuth 2.1 with PKCE and dynamic client registration in front of it (what claude.ai custom connectors expect). The approval screen and the vault pages are protected by the owner passphrase (hash in env).
- **Layers:** `lib/rpc` (pure encoder/decoder, tested on saved real responses) → `lib/google` (session, tokens, throttle, keepalive, error taxonomy) → `lib/notebooklm` (typed operations) → `lib/tools` (MCP tools, zod schemas) → `app` (routes/pages). Pure logic never does I/O.
- **Tools (v1):** `accounts_list`, `notebooks_list`, `notebook_create`, `notebook_rename`, `notebook_get`, `notebook_summary`, `source_add_url`, `source_add_youtube`, `source_add_text`, `source_add_drive`, `source_get_text`, `source_get_guide`, `chat_ask`, `studio_audio_create`, `studio_video_create`, `studio_status`, `studio_download_link`. Every tool takes an optional `account`; with exactly one account it is implied.
- **Long jobs are asynchronous.** Audio/video take minutes to 30+ minutes. `studio_*_create` returns the artifact id at once; `studio_status` polls; Vercel functions never wait. Polling guidance to Claude: no tighter than every 15 s.
- **Downloads:** `studio_download_link` returns a short-lived signed URL on our own domain; the route streams the media from Google, attaching the cookie jar and re-attaching it on every redirect hop (Node `fetch` drops cookies cross-origin, so redirects are followed manually, max 6 hops, only to `*.google.com`, `*.googleusercontent.com`, `*.googleapis.com`). HTML or 0-byte responses are treated as expired auth.
- **Account import:** HttpOnly cookies cannot be read by a bookmarklet (correction to the earlier plan). v1 import = on the vault page, paste the JSON exported from a cookie-export browser extension (e.g. Cookie-Editor) while signed in in a **private window**, then close that window without signing out. Step 8 adds an optional tiny first-party Chrome extension that does the same with one click. No passwords are ever entered or stored.

## 4. Account safety — the "no risk" requirement, made concrete
Honest baseline: this is reverse-engineered access, so Google can change it or flag a session at any time; nothing makes that zero. The design minimises and contains it.

| Threat | Mitigation |
|---|---|
| Account flagging from bursty/robotic traffic | One request at a time per account; 1.5–4 s random gap between RPCs; polling ≥ 15 s; no auto-retry of mutations; backoff on 429/quota; self-imposed daily caps per account below Google's (default audio 2, video 2, chat 30; configurable). Stable browser-like UA and headers per account. |
| Datacenter-IP / fingerprint gate (`location=unsupported`) | Detected and reported as its own error (never retried in a loop). **Go/no-go checkpoint in Step 3.** Plan B if Vercel IPs are gated: keep the same code but run the Google-facing worker where the owner chooses (e.g. a home machine behind a tunnel). Decide with evidence, not before. |
| Session superseded by a second client | Import from a private window and close it without signing out; never run two consumers on one jar; one keep-alive owner per account. |
| Session expiry | Keep-alive `RotateCookies` every ~10–15 min per account via Supabase `pg_cron` → `/api/cron/keepalive` (secret header), plus lazy rotation before use. Expiry detected (redirect to accounts.google.com, no `SNlM0e`, gRPC 16) → account marked `needs_reauth`, tools return a clear message, no retries. |
| Stolen cookies | AES-256-GCM at rest, key only in env (versioned for rotation); decrypted in memory per call only; never logged, never returned by any tool, never sent to the client. RLS on, service key server-side only. Audit log holds no secrets. |
| Compromised connector token | OAuth tokens short-lived with refresh; owner passphrase gates approval; per-account **kill switch** (disable + wipe session) on the vault page; revoke-all button. |
| Claude misused or prompt-injected through source content | Tool results are plain data; no tool can read cookies, change settings or delete; writes limited to the allow-list in `created_objects`; add-source/chat rate-limited. |
| Google changes the protocol | Typed error taxonomy: *drift* (id missing in response) ≠ *refused* (gRPC status) ≠ *auth* ≠ *quota*. `NOTEBOOKLM_RPC_OVERRIDES` env hot-patch; a `health_check` read-only route; golden fixtures recorded from real responses. |
| Double-creating things on timeouts | Mutations are never auto-retried; after an ambiguous failure the client re-lists to reconcile. |

## 5. Edge cases
- Free-tier quotas are uncertain (3/day audio and video per the 2026-07-09 table; a compute-metered allowance may apply since 2026-09-02). The tool reads quota when available, and otherwise reports Google's own quota error verbatim and never retries.
- Source-less notebook → generation fails with INVALID_ARGUMENT; check first and say so.
- Source added but not yet ready (`status` ≠ 2) → `studio_*_create` waits/refuses with a clear message.
- Code 3 can mean wrong payload shape, quota or async accept; reconcile before concluding.
- Chat quota exhaustion shows as a stream with no payload frame; mapped to a quota error.
- Notebook rename only for notebooks in `created_objects`; others are refused.
- Additive writes (add source, create Studio artifact, chat turn) are allowed on any notebook of a connected account; rename is limited to notebooks this app created; nothing is ever deleted.

## 6. Build order (required)
Each step is shippable and testable alone, ordered by the critical path (budget policy in `CLAUDE.md`). Every step ends committed + pushed, with `docs/PROGRESS.md` updated.

1. **Step 1 — Scaffold:** Next.js + TS strict, lint/test/build, `/api/health`, `.env.example`, Vercel project + preview. Check: preview URL shows health OK.
2. **Step 2 — Vault and owner gate:** crypto module (tested), Supabase tables, passphrase login, paste-import of cookies, account list, kill switch. Check: import a test session, see it listed, kill it; DB shows ciphertext only.
3. **Step 3 — Google transport and notebooks (real-data run):** tokens, batchexecute codec, throttle, error taxonomy, keep-alive, `notebooks_list/create/get` against a real account; fixtures saved. **Go/no-go on the Vercel-IP risk here.** Check: real list matches the notebooklm UI.
4. **Step 4 — MCP + OAuth, first connectable build:** Streamable HTTP MCP, OAuth 2.1/PKCE/DCR, approval screen, notebook tools. Check: add the preview URL as a connector in claude.ai and list notebooks.
5. **Step 5 — Sources:** add URL/YouTube/text/Drive, status wait, text and guide, summary. Check: add a URL, see it appear in the native UI.
6. **Step 6 — Audio and video overviews + downloads:** create with all v1 options, status, signed download proxy, daily caps. Check: audio and video appear natively in the notebook and the link plays on the phone.
7. **Step 7 — Chat with citations:** `chat_ask` with source citations. Check: answer and citations match the native chat.
8. **Step 8 — Hardening and release:** `pg_cron` keep-alive, health check, revoke-all, optional one-click Chrome extension, docs. Gates 3, 4, 5, then production merge, then hand-off with the connector URL.
9. **Step 9 — Stretch (only if time/credits remain):** file-upload sources (Scotty).

## 7. Decision log (required)
| Date | Decision | Decided by | § |
|---|---|---|---|
| 2026-10-30 | Own TypeScript client for the internal RPC, free via logged-in sessions | Simooo1010 | 1, 2 |
| 2026-10-30 | Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) | Simooo1010 | 3 |
| 2026-10-30 | Autonomous mode; production merge delegated to Claude after gates 1–5 | Simooo1010 | CLAUDE.md |
| 2026-10-30 | v1 scope: notebooks+sources, chat, audio+video overviews; no deletes | Simooo1010 | 1 |
| 2026-10-30 | Dependencies approved: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint | Simooo1010 | CLAUDE.md |
| 2026-10-30 | Budget policy (models, effort, resume-safe) | Simooo1010 | CLAUDE.md |
| 2026-10-30 | Import by pasted cookie JSON, not a bookmarklet (HttpOnly cookies); extension optional in Step 8 | Simooo1010 | 3 |
| 2026-10-30 | Vercel-IP go/no-go in Step 3; if gated, build continues on unaffected work and Claude stops to report options (Plan B = owner-hosted worker) | Simooo1010 | 4 |
| 2026-10-30 | Spec v1 approved; autonomous run Steps 1–8 authorised | Simooo1010 | all |
| 2026-10-30 | Owner passphrase may be supplied as plain env OWNER_PASSPHRASE (compared in constant time) or as scrypt OWNER_PASSPHRASE_HASH; Claude-proposed, owner-informed | Claude, informed to Simooo1010 | 3 |
| 2026-10-30 | Additive writes allowed on any notebook; rename restricted; no deletes (interpretation of CLAUDE.md write rule) | Claude, informed to Simooo1010 | 5 |
