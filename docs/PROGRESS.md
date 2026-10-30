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

## In progress
- Step 1 done and in draft PR #2 (stacked branches: each step branches from the previous step branch; `main` stays docs-only until the release, since main = production).

## Open questions / blocked
- Vercel: project `gemnotebook-to-chatbot` (id prj_HsepRykVi9O4CpzaG1M9YnT6A4kE, team simone-dr-s-projects) IS linked to the repo (the first `create_git_project` reply was a schema error but the project was created; the agent's immediate `list_projects` raced it). Branch `step-1-scaffold` deployed READY. Live `/api/health` fetch NOT verified from the sandbox (Vercel fetch tool has no access; Vercel Authentication is on for previews and production URLs). **Before Step 4 (connector) this protection must be switched off for the production domain; OAuth protects the MCP endpoint instead.**

## Next
1. (done) Spec v1 approved 2026-10-30 incl. paste-JSON import and Vercel-IP go/no-go.
2. Step 2 — Vault and owner gate: 2a and 2b done (branch `step-2-vault`, draft PR against `step-1-scaffold`). The SQL migration is applied in the final manual run once the owner names the Supabase project.
3. Next = Step 3b (per the plan; Step 3 = Google transport and notebooks, real-data run + Vercel-IP go/no-go).

## Standing rules
- Opus subagents: effort low at most (never higher). Sonnet/Haiku: High at most.

## Decisions so far (move to SPEC decision log when it exists)
- Own TypeScript client for NotebookLM internal RPC; free, via logged-in sessions.
- Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) + pasted-cookie-JSON import (bookmarklet impossible: HttpOnly); OAuth 2.1 in front.
- v1 scope: notebooks + sources, chat with citations, audio + video overviews. Other Studio outputs out of v1. No deletes.
- Approved deps: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint.
