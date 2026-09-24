/**
 * Markdown forms: the grammar, the round-trip, and who may write what.
 *
 * Three things are being proved here, and they fail for different reasons.
 *
 * **The grammar fails closed.** A block that does not parse leaves the form
 * inert — no submission lands, and the note stays ordinary Markdown. Every
 * refusal below names the line, because the author is the person who can fix
 * it.
 *
 * **The round-trip is lossless under hostile input.** The gateway rewrites the
 * whole response file on every submission, edit and vote, which means it parses
 * back what it wrote. A submission containing a table row, a heading, a
 * `**Votes:**` line or a trailing backslash must come back as itself — and must
 * not be able to forge a second response, or somebody else's name, by being
 * written into the file verbatim. That is the injection surface here, and it is
 * the same shape as the `privacy.md` newline injection this repo already
 * closed: a renderer interpolating attacker text into a line-oriented format.
 *
 * **A `member` can submit and can do nothing else.** This is the only write in
 * the gateway that does not require `context:write` in the target context, so
 * the gate is two-part and both halves are checked: the *grant* must still have
 * asked for write (a client connected read-only stays read-only), and the
 * *form* must admit that role. Everything else a member could reach through
 * these tools — another person's response, a form that does not take their
 * role, a response file in another tenant — is refused.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/forms.js` and `src/index.js`, and
 * reverted. Numbers are what actually failed, not what was expected to.
 *
 * 1. **`escapeCell` returns its argument unchanged** — 5 checks failed. The
 *    file stopped parsing at all, which is the loud half; the quiet half is
 *    that a submitted `|` had already become a column boundary by then.
 * 2. **`unescapeCell` written as six sequential `.replace()` calls in the same
 *    order as the escape** — 2 checks failed. First attempt: **0**, and the
 *    reason is worth keeping — this escaping is robust to *most* orderings, so
 *    a sequential inverse is usually right. It is wrong for exactly one input:
 *    a literal `<br>`, which `&lt;`-first turns back into a line break. That
 *    string is now in the fixture, and it is the only thing standing between
 *    the single left-to-right scan and a plausible "simplification".
 * 3. **The write gate exempts `FORM_TOOLS` without `participatesInForms`** — 5
 *    checks failed, led by the read-only grant submitting. That is the gate's
 *    whole point: read-only has to mean read-only even for somebody whose
 *    membership would otherwise allow a response.
 * 4. **`mayChangeResponse` always allows** — 5 checks failed: a member edited
 *    another member's response, and `edit_own: false` stopped meaning anything.
 * 5. **The recorded name is a constant rather than `store.actor.name`** — 4
 *    checks failed. The `by` argument is separately refused by the advertised
 *    schema before any handler sees it, so proving the stamp needed two people
 *    submitting to one form, not one person trying to claim a name.
 * 6. **The marker check in `parseResponsesFile` is removed** — 1 check failed.
 *    Only one, and that is correct rather than thin: a form aimed at somebody's
 *    note is stopped a second time by `ensureFormResponseFiles`, which only
 *    ever creates. Two independent guards, one of which this sabotage leaves
 *    standing.
 * 7. **The `onlyIf.etagMatches` is dropped from the response write** — 1 check
 *    failed, and it failed by losing the interleaved response rather than by
 *    erroring. First attempt: **0**, because the test's interleaving write ran
 *    *before* the read took its snapshot, so the caller had already merged the
 *    other response and no conflict was possible. The hook now fires after the
 *    snapshot, which is the only ordering that models the race.
 * 8. **`escapeBlock` returns its argument unchanged** — 6 checks failed,
 *    including a submitted paragraph forging a third response under another
 *    person's username.
 * 9. **`SECTION_HEADER_RE` narrowed back to `(\S+)` for `by`** — 7 checks
 *    failed: every sections response carrying a stamp that is not a handle,
 *    and the id check that only runs once such a header is recognised at all.
 * 10. **One of the two readers of that constant inlines its own copy** — 7
 *    checks failed, the same set. Two readers of one line is why it is a
 *    constant: a header the scan finds and the walk does not silently drops
 *    the response under it.
 * 11. **`by` widened to `(.+?)` — any character, delimiter included** — 1
 *    check failed. First attempt: **0**, and the reason is the finding: the
 *    bound was prose. Nothing this module writes can put a `·` in `by`, so
 *    nothing exercised it, and a header carrying one would have been re-split
 *    with the timestamp read out of the middle of a name. There is now a
 *    fixture with one, and a positive control beside it.
 * 12. **A `/g` flag on that same shared constant** — **0**, and left at 0
 *    deliberately. One regex object used by both a `.test` and an `.exec`
 *    carrying `lastIndex` between them is the classic bug, so it was worth
 *    measuring; it is inert here because the expression is anchored with no
 *    `m` flag, so an `exec` resuming past position 0 cannot match and resets
 *    `lastIndex` itself. Measured rather than argued, and recorded so the next
 *    person does not have to measure it again.
 *
 * One test-quality finding came out of the same pass: sabotage 1 originally
 * took the whole suite down rather than failing one check, because the
 * round-trip assertions dereferenced a parse that had just failed. Every check
 * reached by an unparseable file now fails instead of throwing.
 *
 * This file used to hold every one of these checks directly, in one
 * 1,962-line function. It is now a thin facade over `test/forms/*.test.mjs`,
 * split by topic, so `import { runFormChecks } from "./forms.test.mjs"` keeps
 * working unchanged and every check still runs in its original order.
 *
 * The grammar and round-trip sections are pure-function checks with no
 * control-plane dependency and split cleanly. "Permissions, through the
 * worker" is one continuous scenario building up state in one bucket across
 * ten numbered sections, so its harness (control plane, workspaces, grants,
 * the bucket and env) moved to fixtures.mjs's `createFormsHarness`, threaded
 * through the two files that need it. The clean seam within it is between
 * §6 (votes) and §7 (what a form may not be pointed at): every subsection
 * from §7 on builds its own local state rather than reading a variable an
 * earlier one defined, confirmed by grepping for `config`, `reparsed`,
 * `editorId`, `otherMemberId` and `requestId` across that range and finding
 * none of them referenced.
 */

import { createFormsHarness } from "./forms/fixtures.mjs";
import { runFormGrammarAndRenderingChecks } from "./forms/grammarAndRendering.test.mjs";
import { runFormRoundTripUnderHostileInputChecks } from "./forms/roundTripUnderHostileInput.test.mjs";
import { runFormSubmissionsEditsAndVotesChecks } from "./forms/submissionsEditsAndVotes.test.mjs";
import { runFormTargetingAndConcurrencyChecks } from "./forms/targetingConcurrencyAndCreateForm.test.mjs";

export async function runFormChecks(check) {
  await runFormGrammarAndRenderingChecks(check);
  await runFormRoundTripUnderHostileInputChecks(check);

  const harness = await createFormsHarness();
  try {
    await runFormSubmissionsEditsAndVotesChecks(check, harness);
    await runFormTargetingAndConcurrencyChecks(check, harness);
  } finally {
    harness.restoreAll();
  }
}
