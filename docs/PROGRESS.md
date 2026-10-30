# PROGRESS — resume log

Read after CLAUDE.md, WORKFLOW.md and SPEC.md. Updated in the same commit as every step.

**Deadline:** connector ready by 2026-10-31 22:00.
**Mode:** Autonomous, production merge delegated (see CLAUDE.md).

## Done
- Playbook adopted; CLAUDE.md and SETUP-FOR-OWNER.md filled; `main` created (owner OK 2026-10-30).
- Interview answers recorded (see below).
- Spec v1 approved by owner (2026-10-30); autonomous run authorised.

- Step 1 (scaffold) built on branch `step-1-scaffold`, draft PR open: Next.js 16 App Router + TS strict, ESLint, Vitest, `/api/health` (env NAMES only), security headers, `.env.example`. lint/build/tests pass (4 tests); `/api/health` verified locally with `next start`.

## In progress
- Step 1: Vercel project NOT linked yet (see open questions). No preview URL.

## Open questions / blocked
- Vercel: `create_git_project` (team `simone-dr-s-projects`, project `gemnotebook-to-chatbot`, repo Simooo1010/gemnotebook-to-chatbot) failed 2026-10-30 with "Vercel returned a response that does not match the expected schema" (outcome unknown); `list_projects` afterwards shows no such project. No Vercel CLI/token in the sandbox, so no fallback attempted. Owner: import the repo in the Vercel dashboard (Add New → Project → gemnotebook-to-chatbot, framework Next.js), or Claude retries the MCP call next session.

## Next
1. (done) Spec v1 approved 2026-10-30 incl. paste-JSON import and Vercel-IP go/no-go.
2. Link Vercel project, confirm preview shows health OK, then Step 2 — Vault and owner gate.

## Standing rules
- Opus subagents: effort low at most (never higher). Sonnet/Haiku: High at most.

## Decisions so far (move to SPEC decision log when it exists)
- Own TypeScript client for NotebookLM internal RPC; free, via logged-in sessions.
- Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) + bookmarklet import; OAuth 2.1 in front.
- v1 scope: notebooks + sources, chat with citations, audio + video overviews. Other Studio outputs out of v1. No deletes.
- Approved deps: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint.
