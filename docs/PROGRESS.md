# PROGRESS — resume log

Read after CLAUDE.md, WORKFLOW.md and SPEC.md. Updated in the same commit as every step.

**Deadline:** connector ready by 2026-10-31 22:00.
**Mode:** Autonomous, production merge delegated (see CLAUDE.md).

## Done
- Playbook adopted; CLAUDE.md and SETUP-FOR-OWNER.md filled; `main` created (owner OK 2026-10-30).
- Interview answers recorded (see below).
- Spec v1 approved by owner (2026-10-30); autonomous run authorised.

- Step 1 (scaffold) built on branch `step-1-scaffold`, draft PR open: Next.js 16 App Router + TS strict, ESLint, Vitest, `/api/health` (env NAMES only), security headers, `.env.example`. lint/build/tests pass (4 tests); `/api/health` verified locally with `next start`.

- Step 2a (vault crypto core) on branch `step-2-vault`: `src/lib/vault/` (crypto.ts AES-256-GCM envelope + keyring/rotation, jar.ts cookie import/header/Set-Cookie merge, storage.ts ports, memory.ts adapters, vault.ts service with kill/revoke) and `src/lib/auth/passphrase.ts` (scrypt/plain verify, login limiter). 54 tests; lint/build pass. No PR yet.

- Step 2b (owner login, vault pages, Supabase adapter) on branch `step-2-vault`: `src/lib/vault/supabase.ts` + `index.ts` (`getVault()`: Supabase when configured, in-memory only outside production, fails closed in production), `supabase/migrations/0001_vault.sql` (written, NOT applied), `src/lib/auth/session.ts` (HMAC owner cookie, 12 h, origin check), `src/lib/owner/handlers.ts` + routes (`/api/owner/login|logout`, `/api/vault/accounts` GET/POST, `.../[id]/kill`, `/api/vault/revoke-all`), pages `/login` and `/vault` (light/dark, phone width). SPEC decision logged: plain `OWNER_PASSPHRASE` allowed. lint/build pass; 111 tests pass. Dev server smoke: `/login` 200, `/vault` redirects when signed out, `/api/vault/accounts` 401 unauthenticated, login + import error path work with in-memory vault.
- NOT verified live: nothing ran against a real Supabase project (SQL unapplied; adapter tested against a fake client only); no preview-URL check of the pages on a phone; no real Google cookie export imported; the login limiter is in-memory per serverless instance (best-effort on Vercel).

- Step 3a (pure RPC codec) in `src/lib/rpc/` merged into branch `step-3-transport`.
- Step 3b (Google transport core) on branch `step-3-transport`: `src/lib/google/` — `throttle.ts` (per-account queue, 1.5–4 s jittered gap, 15 s poll floor, daily caps audio 2/video 2/chat 30 via `UsageCounter`, exponential capped cooldown honouring Retry-After), `http.ts` (`FetchLike`, Chrome UA headers, `fetchWithJar` manual redirects ≤6 hops with cookie re-attach + Set-Cookie merge per hop, Google-host allow-list, `fetchMedia` rejecting HTML/0-byte), `session.ts` (`fetchPageTokens` + typed SignedOut/RegionGate/CookieMismatch/UnknownHomepage errors, TTL token cache), `keepalive.ts` (`rotateCookies` once/60 s, `keepAliveAccount` → `needs_reauth` on auth failure), `client.ts` (`createGoogleClient().rpc`: read retry-once on auth, mutations never retried, `AmbiguousMutationError`, quota → cooldown, audit rows without secrets), `errors.ts`, `testing.ts` (fake fetch/clock). 176 tests; lint/build pass. All I/O injected; no real network in tests.
- NOT verified against real Google: no live homepage/RotateCookies/batchexecute call has been made yet (needs a real imported session, Step 3c).

- Step 3c (notebook operations, write allow-list, probe) on branch `step-3-transport`: `src/lib/notebooklm/created.ts` (`CreatedObjects` port, memory + Supabase adapters over `created_objects`, `getCreatedObjects()` fails closed in production) and `notebooks.ts` (`listNotebooks` paged in memory with opaque cursor, default 20 / max 100; `createNotebook` records the id and reconciles by re-listing after an ambiguous failure; `getNotebook`; `renameNotebook` only for allow-listed ids, else `NotWritableError`; `notebookSummary`; zod validation). `src/lib/google/client.ts` fix: a mutation auth failure now runs a page-token read first: signed_out/cookie_mismatch -> `needs_reauth`; session still alive -> token cache refreshed and `StaleTokenMutationError` (write NOT confirmed, list before retrying). Probe: `GET /api/probe/google` (Bearer `CRON_SECRET`, constant time, fails closed) does one unauthenticated homepage GET and returns only `{classification, finalHost, finalPath, status, hopHosts}`. lint/build pass; 213 tests pass.
- Step 3 code complete but NOT verified against real Google: no live call has been made; fixtures are synthetic. The Vercel-IP probe result is recorded by the orchestrator after deploy (expected on a healthy datacenter IP: sign-in redirect to accounts.google.com; a gate looks like `location=unsupported`). The signed-in real-data run happens in the final manual run.

## In progress
- Step 1 done and in draft PR #2 (stacked branches: each step branches from the previous step branch; `main` stays docs-only until the release, since main = production).

## Open questions / blocked
- Vercel: project `gemnotebook-to-chatbot` (id prj_HsepRykVi9O4CpzaG1M9YnT6A4kE, team simone-dr-s-projects) IS linked to the repo (the first `create_git_project` reply was a schema error but the project was created; the agent's immediate `list_projects` raced it). Branch `step-1-scaffold` deployed READY. Live `/api/health` fetch NOT verified from the sandbox (Vercel fetch tool has no access; Vercel Authentication is on for previews and production URLs). **Before Step 4 (connector) this protection must be switched off for the production domain; OAuth protects the MCP endpoint instead.**

## Next
1. (done) Spec v1 approved 2026-10-30 incl. paste-JSON import and Vercel-IP go/no-go.
2. Step 2 — Vault and owner gate: 2a and 2b done (branch `step-2-vault`, draft PR against `step-1-scaffold`). The SQL migration is applied in the final manual run once the owner names the Supabase project.
3. Step 3a-3c code done. Next = Step 4: MCP + OAuth (first connectable build) with the notebook tools; Vercel-IP go/no-go from the probe is recorded first.

## Standing rules
- Opus subagents: effort low at most (never higher). Sonnet/Haiku: High at most.

## Decisions so far (move to SPEC decision log when it exists)
- Own TypeScript client for NotebookLM internal RPC; free, via logged-in sessions.
- Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) + pasted-cookie-JSON import (bookmarklet impossible: HttpOnly); OAuth 2.1 in front.
- v1 scope: notebooks + sources, chat with citations, audio + video overviews. Other Studio outputs out of v1. No deletes.
- Approved deps: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint.

## Vercel-IP early probe
- `scripts/probe-google.mjs` runs as `prebuild` on Vercel only (unauthenticated GET of the homepage from the build machine; metadata only; never fails the build). Result is read from the deployment build log and recorded here. Runtime function IPs may differ from build IPs; the signed-in check in the final manual run is the real test.
