# CLAUDE.md — working rules for this repo

## What this is
A remote MCP server (Next.js on Vercel) that lets Claude use Google NotebookLM — notebooks, sources, chat with citations, and native audio/video overviews — through the owner's own logged-in Google sessions, at no extra cost (no paid Enterprise API).
- Product spec: `docs/SPEC.md`
- Working method: `docs/WORKFLOW.md` — **read it before any work, every session.**
- Owner-only setup steps: `SETUP-FOR-OWNER.md`

## Project settings
- **Owner:** Simooo1010
- **Approval mode:** Autonomous (definitions in `docs/WORKFLOW.md` §3)
- **Milestones:** n/a (Autonomous)
- **Deadline:** connector ready to connect by 2026-10-31 22:00 (owner's local time).
- **Production merge:** delegated to Claude after all QA gates (WORKFLOW §6, gates 1–5) pass — Simooo1010, 2026-10-30. Conditions: spec steps for v1 done, no failing check, no open review findings, owner's setup steps verified.
- **Test device(s):** Claude app (web / phone) with the custom connector added.
- **Supported:** themes: light + dark (login/vault page only) · sizes: phone + desktop.
- **Design system:** none.

## Stack
- Next.js (App Router) + TypeScript strict, deployed on Vercel (preview per branch, production = `main`).
- MCP over Streamable HTTP via `mcp-handler`; OAuth 2.1 (PKCE) in front of it. NotebookLM access through our own client for its internal batchexecute RPC. Google session cookies are encrypted at rest (AES-256-GCM) in Supabase. Credentials used on the server only.
- **Approved dependencies:** next, react, react-dom, typescript, `@modelcontextprotocol/sdk`, `mcp-handler`, `zod`, `@supabase/supabase-js`, vitest, eslint (approved by Simooo1010, 2026-10-30). Nothing else without asking.

## Folder layout
```
CLAUDE.md                 rules (this file)
SETUP-FOR-OWNER.md        steps only the owner can do
docs/WORKFLOW.md          the method
docs/SPEC.md              the product spec (source of truth)
docs/SPEC.template.md     template
docs/HOW-TO-WORK-WITH-CLAUDE.md
(src layout is added by Step 1 and recorded here in the same commit)
```

## Commands
Filled in by Step 1 (`npm run lint`, `npm run build`, `npm test`, `npm run dev`).

## Where this runs
- Development in Claude Code on the web (cloud sandbox). No local machine.
- Secrets: sandbox environment variables + Vercel environment variables. Never in repo files.
- Owner tests on **preview URLs**, adding the preview's MCP URL as a custom connector.

## Hard rules
- Never commit secrets. Only `.env.example` is committed. Never print secret values — including Google cookies, tokens and the encryption key. Never log request/response bodies that can contain them.
- No secret reaches the client (no public env prefix on secrets). Claude/MCP clients never receive Google cookies.
- Use the exact external names in `docs/SPEC.md` §2. If something is missing or named differently (e.g. an RPC ID changed): **stop and report**. Never guess or rename.
- The app writes only: notebooks it creates, sources it adds, Studio artifacts it generates, and its own vault rows. **No deletes of any NotebookLM data in v1.** Never edit or remove anything else.
- Every outbound Google call goes through the per-account throttle (no parallel bursts, human-like pacing). Never retry aggressively; on auth/RPC breakage, fail loudly with a clear error.
- Always paginate external queries.
- No fake data, except fixtures inside tests.
- Ask before adding any dependency not listed above; record approvals here.
- Run lint, build and tests before saying a step is done. Show the output.
- Never start the next step or merge beyond what the approval mode allows.

## Budget policy (credits) — owner instruction 2026-10-30
- **Models:** **Sonnet is the default** for almost everything (best quality per credit): scaffolding, routes and pages, MCP tool wrappers, typed NotebookLM operations, tests, fixtures, docs, polling and status logic, research, read-only sweeps, QA walkthroughs. **Opus (effort low) only where a mistake is costly and hard to spot:** the crypto vault, OAuth 2.1/PKCE, the batchexecute codec + error taxonomy, throttle/keep-alive, and the independent security review of those files. Review (gate 3) is done by a separate agent, once per gate; Sonnet reviews the rest. Haiku for trivial lookups.
- **Effort:** Opus at **low** at most — never medium, high, max or ultra (owner rule 2026-10-30). Sonnet/Haiku: High at most, lower for mechanical work. Compensate low effort with small steps, tests first for risky logic, and the independent review gate.
- **Spend order:** critical path first (vault → auth → notebooks/sources → audio/video overview → chat). Polish and extras last. If credits run short, cut from the end of the build order, never from checks or safety rules.
- **No waste:** no polling or sleep loops (events wake the session); don't re-read files already in context; parallel subagents only for independent work that pays off; one batched tool call over many small ones.
- **Resume-safe:** every step ends committed + pushed, and `docs/PROGRESS.md` is updated in the same commit (done / in progress / next / open questions). A session that starts cold reads CLAUDE.md, WORKFLOW, SPEC, PROGRESS and continues without asking the owner to repeat anything.
