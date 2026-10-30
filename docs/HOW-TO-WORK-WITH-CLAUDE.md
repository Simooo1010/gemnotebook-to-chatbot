# How to work with Claude — the owner's side

The method only works if both sides do their part. This is yours.

## 1. Start a new project
1. Create the GitHub repo and open a Claude Code on the web session on it.
2. Copy this kit into the repo: `CLAUDE.md`, `SETUP-FOR-OWNER.md`, `docs/WORKFLOW.md`, `docs/SPEC.template.md`, this file.
3. Send the kick-off prompt (§4).
4. Answer the interview. Pick options fast; type "Other" whenever none fits. The more precise you are here, the less rework later.
5. Read `docs/SPEC.md`. Approve it explicitly ("Spec approved") or say what to change.
6. Do the steps in `SETUP-FOR-OWNER.md`.

## 2. During each step
- Test **only on the preview URL**, on your real device, following the check list.
- Reply with one of:
  - **"OK"** → approved, Claude moves on (as the approval mode allows).
  - **A numbered list of problems** → what you did, what you saw, what you expected. A screenshot helps.
  - **"Change of plan: …"** → Claude updates the spec and decision log first, then the code.
- Don't approve a step you haven't tested. Approval is what keeps quality high.
- Ignore things listed under "Not in this step".

## 3. What to give Claude
- Real data and real examples, never invented ones.
- Exact names from your external systems (or let Claude read them).
- Decisions in writing in the chat; Claude records them with the date.
- Never secret values in chat — put them in the environment variables (see `SETUP-FOR-OWNER.md`).

## 4. Prompts

**Kick-off**
> Read `CLAUDE.md` and `docs/WORKFLOW.md`. We work exactly this way. Interview me with multiple-choice questions until you can write `docs/SPEC.md` (exact data names, build order, decision log). No code until I approve the spec. Then fill in `CLAUDE.md` and `SETUP-FOR-OWNER.md`.

**Next step**
> Next: Step N. Follow the step loop in WORKFLOW §4 and give me the hand-off.

**Feedback**
> Step N, on the preview: 1. I tapped X, I saw Y, I expected Z. 2. …

**Change the approval mode**
> Switch approval mode to <Strict | Milestone | Autonomous> and record it in CLAUDE.md.

**Release**
> Run all QA gates (WORKFLOW §6) and report. Don't merge to production until I say so.

**New session after a break**
> Re-read CLAUDE.md, WORKFLOW and SPEC. Tell me where we are: last step done, open PRs, open questions.

## 5. Choosing the approval mode
- **Strict** — new project, unclear requirements, or anything with real data writes. Default.
- **Milestone** — spec is solid and the first steps went well.
- **Autonomous** — small, low-risk project, or you're away and will review at the end.
