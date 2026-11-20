# Checks read a draft together and send it back once

Decided by the owner, 2026-11-17 (the "jobs as config" plan, part A).

On 2026-11-17 a background job's parts were each sent back three times, one
code check at a time: "make it a page, not a text" (`workPage.js`), then
"that's an essay" (`wordy.js`), then "send ONE casual line". Each rewrite
tripped the next check, and the third send-back crashed the part, so the
answer it already had was lost ten times. The checks ran as a chain where the
first to fire won and the rest waited for the rewrite.

## The rule

- Every code check (`claimCheck.js`, `replyChecks.js`, `doItChecks.js`) reads
  the same draft, and it goes back **once** with every finding
  (`packages/tex/gateway/agent/checkFindings.js`). One finding goes back word for word.
- A **fact** is something the turn's own record proves wrong (a change claimed
  with no call, a link nothing gave, a figure nothing read, a browser never
  tried, a look-up handed back, a bare page with no cover). Facts block.
- **Advice** is about shape: a page rather than a text, too wordy, one line
  beside a page, a card for a list, a plain note that should be a page. It
  rides along with facts; on its own it never holds a job's answer, and on a
  chat turn it may cost one rewrite a turn. Advice found but not sent is not
  spent.
- At most one form-or-length advice is given in a turn, and none beside a fact
  that itself sets the shape (`owed-picture`), so two notices never
  contradict. At most two "you gave up too soon" facts go back on one draft.

## What a simplification would cost

Going back to first-wins checks brings back one round per check, and with it
the contradicting notices and the loop-cap crash. Making style block again in
jobs brings back the timecards incident. Tests:
`apps/mcp/test/agentCheckFindings.test.mjs`.

The loop budget itself (the runner's cap on the `answerCheck -> fd` wire, and
what a spent budget sends) is a separate step of the same plan.
