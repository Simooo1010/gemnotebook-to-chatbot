# PROGRESS — resume log

Read after CLAUDE.md, WORKFLOW.md and SPEC.md. Updated in the same commit as every step.

**Deadline:** connector ready by 2026-10-31 22:00.
**Mode:** Autonomous, production merge delegated (see CLAUDE.md).

## Done
- Playbook adopted; CLAUDE.md and SETUP-FOR-OWNER.md filled; `main` created (owner OK 2026-10-30).
- Interview answers recorded (see below).

## In progress
- Awaiting owner's explicit "Spec approved" on `docs/SPEC.md` (draft v1 written, protocol in `docs/PROTOCOL.md`).

## Next
1. Owner approves SPEC.md (also two pending decisions: cookie-paste import instead of bookmarklet; Vercel-IP go/no-go with owner-hosted Plan B). Record in decision log.
2. Step 1 onward per SPEC §6.

## Decisions so far (move to SPEC decision log when it exists)
- Own TypeScript client for NotebookLM internal RPC; free, via logged-in sessions.
- Remote HTTPS MCP on Vercel; multi-account encrypted vault (Supabase) + bookmarklet import; OAuth 2.1 in front.
- v1 scope: notebooks + sources, chat with citations, audio + video overviews. Other Studio outputs out of v1. No deletes.
- Approved deps: next, react, typescript, @modelcontextprotocol/sdk, mcp-handler, zod, @supabase/supabase-js, vitest, eslint.
