# Everything that changes a reply is a step: the no-shadow steps (2026-11-24)

The shadow-code audit of 2026-11-23 (`projects/tex-quality/shadow-code-audit-2026-11-23.md` in the team's notes) found
code that changes what Tex sends running inside other steps, where the config, the Lab and Replay never show it: the
claim checks inside the Answer check, the reply reviewer with no step, the edits to the reply inside Text them, the
group "look again" in the texting Worker, and the rules every tool call passes. Dev2: "we should not be having shadow
code. Everything should live inside of a node." Dev2 drew the steps as Lab draft `vmwtgxyawavru` and said "build".

The decision: **each of these is a step of Tex's config**, with the files that do its work named on it, a row in the
chat's record when it runs, and its switches as step settings ([step-settings](./step-settings.md)).

| Step | Wire | What it holds |
|---|---|---|
| Claim checks (`claimChecks`) | `answerCheck -> claimChecks`, uses | The code rules that send a draft back (`claimCheck.js`, `replyChecks.js`, `wordy.js`, `standsCheck.js`, ...). Settings: On every text, the two word limits. |
| Reply reviewer (`reviewer`) | `answerCheck -> reviewer`, uses | The model read of a report or routine (`replyJudge.js` `review`). |
| Finish the text (`finish`) | `answerCheck -> finish -> send`, wait | The gateway's work on the words after the checks (`texEntryPoint/finishTheText.js`): the ask and offer lines, silence and the empty fallback, and its switches Trim flattery, Link the saved note and Drop a stale answer. Text them only delivers. |
| Still answers them? (`recheck`) | `send -> recheck`, uses | Clef's look, asked by the texting Worker before a group reply goes (`textsDecide.js`). Turned off, every reply goes and no model is asked. |
| Tool rules (`toolRules`) | `tools -> toolRules`, uses | What every tool call passes. Switches: Same ask twice, Where a new note goes, Links in results. The security rules (vault, mail agent, the chat's write lock, their notes kept) are always on. |

Every switch ships on the value the code had, so main's behaviour is unchanged; turning one off is a Lab draft, tried in
a test chat and gated by the Test set like any other change.

Where the build differs from the draft:

- **Still answers them?** hangs off Text them, not between the Answer check and Finish the text. It runs in the
  texting Worker after the gateway has answered, before the reply is delivered, so that is where it is wired.
- **Nothing was deleted yet.** The draft named the flattery trim, the saved-note link and the stale-answer drop for
  deletion. They are switches on Finish the text, on main's values, so turning them off is measured before it ships.

`scripts/tex-diagram-check.mjs`'s list of code checks with no step (`CODE_CHECKS_NOT_NODED_YET`) went from 28 files to
10 with this change; it only shrinks.

**What a simplification would cost.** Folding a check back into another step's code hides it from the Lab and Replay
again, and the next bad reply cannot be traced to the rule that made it.

**Tests that fail if reversed:** `apps/mcp/test/texNoShadowSteps.test.mjs`, `apps/mcp/test/texGraphTurn.test.mjs`
(the checks are rows of their own), `apps/mcp/test/textsDecide.test.mjs` (Still answers them? off), the replay case
`finish-step-owns-the-words`, and `packages/lab/__tests__/texLabStepLogs.test.ts`.
