# The advisor is four roles, each replayed on its own

Decided by the owner, 2026-11-13, while building the replay gate: "I know we
have one advisor agent for the main agent gateway, the done check, stuff like
that. ... should we just split them up to be different agents so that they can
be evaluated separately?", then "split by role, one model" on the card.

## Why

One model (`models.advisor`, Opus 5.5) answers four different questions: the
front door's `ask_advisor`, the job check at every stop of a background job,
the big-ask planner, and the advisor on a job note's mail. Their instructions
sat in four files mixed in with the code around them, and the replay gate had
no area for any of them. So a change to the job check's wording could not be
told apart from a change to the front door's advisor, and neither ran a case.

## The rule

1. **Each role's instructions are a file of their own** in
   `apps/mcp/src/agent/advisorRoles/`: `chat.js` (ask_advisor), `jobCheck.js`
   (the job check), `planner.js` (plan_big_ask) and `jobMail.js` (the advisor
   on the mail). `knowsMail.js` is the line about a job note's mail that the
   two roles reading a job share.
2. **What they share is the core**, `advisorRoles/core.js`: how one ask is sent
   (the drawing ahead of the role's instructions, no tools, its thinking
   summarized) and how its thinking is read back. Every role goes through
   `adviseOnce`.
3. **Each role is an area of the replay gate** (`apps/mcp/bench/replayAreas.mjs`):
   `advisor-chat`, `advisor-job-check`, `advisor-planner`, `advisor-job-mail`,
   each with its own cases in `apps/mcp/bench/advisor/<role>.json` and its
   scorer in `apps/mcp/bench/advisor.mjs` (`pnpm ai advisor-<role>`). A change
   to a role's instructions, its brief builder (`advisor.js`, `jobCheck.js`,
   `planBigAsk.js`) or its cases runs that role alone; a change to the core
   runs all four; `knowsMail.js` runs the two job roles. Held-out cases go in
   `@context-lc ai/held-out/advisor-<role>.md`, as for every area.
4. **Same model, same behaviour.** The split moved the words and the brief
   builders as they were; every role's request is the one production sends.

## Cost

Opus 5.5 at effort high. AI Gateway, 2026-11-06 to 11-13: a job check about
$0.05 a call, a front door ask about $0.25 (it reads a whole live turn). A
case's invented turn is short and its instructions are cached after the first
ask, so the sets are kept small (three or four cases a role) and a core change
running all four stays inside the gate's $1 with a case to rerun. The gate
counts a role's first run at what it measured.

## What a simplification costs

Folding the roles back into one area means every advisor change pays for all
four and a regression in one cannot be named. Moving a role's words back into
the code around them lets a plumbing change run model cases, or a wording
change run none.

## What fails if it is reversed

`apps/mcp/bench/test/replayGate.test.mjs` ("an advisor role's file runs that
role alone"), `apps/mcp/bench/test/advisor.test.mjs` (each role's case is put
as production puts it), and the gateway tests that pin each role's request
(`agentAdvisor.test.mjs`, `agentJobCheck.test.mjs`, `agentPlanBigAsk.test.mjs`,
`jobNote.test.mjs`).
