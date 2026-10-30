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

## In progress
- Step 1 done and in draft PR #2 (stacked branches: each step branches from the previous step branch; `main` stays docs-only until the release, since main = production).

## Open questions / blocked
- Vercel: project `gemnotebook-to-chatbot` (id prj_HsepRykVi9O4CpzaG1M9YnT6A4kE, team simone-dr-s-projects) IS linked to the repo (the first `create_git_project` reply was a schema error but the project was created; the agent's immediate `list_projects` raced it). Branch `step-1-scaffold` deployed READY. Live `/api/health` fetch NOT verified from the sandbox (Vercel fetch tool has no access; Vercel Authentication is on for previews and production URLs). **Before Step 4 (connector) this protection must be switched off for the production domain; OAuth protects the MCP endpoint instead.**

## Next
1. (done) Spec v1 approved 2026-10-30 incl. paste-JSON import and Vercel-IP go/no-go.
2. Step 2 — Vault and owner gate (branch `step-2-vault` from `step-1-scaffold`). 2a done; next 2b: Supabase tables + adapter, login, vault pages (paste-import, list, kill).

## Standing rules
- Opus subagents: effort low at most (never higher). Sonnet/Haiku: High at most.

## Decisions so far (move to SPEC decision log when it exists)
- Own TypeScript client for NotebookLM internal RPC; free, via logged-in sessions.
- Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) + pasted-cookie-JSON import (bookmarklet impossible: HttpOnly); OAuth 2.1 in front.
- v1 scope: notebooks + sources, chat with citations, audio + video overviews. Other Studio outputs out of v1. No deletes.
- Approved deps: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint.
