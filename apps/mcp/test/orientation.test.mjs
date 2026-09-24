/**
 * Orientation: the budgeted walk, and the handshake that must not depend on it.
 *
 * `orient` is the first thing a connected agent calls and the only thing that
 * tells it what is in here, so it has two failure modes that matter and neither
 * is a privacy bug (those live in `test.mjs`, against the shared fixture):
 *
 * 1. **It lies about size.** The walk is bounded — it runs against a bucket we
 *    do not own, on the customer's request quota — so a context bigger than the
 *    budget must report a floor. A precise-looking number that is not the truth
 *    is the bug this repository has already shipped twice.
 * 2. **It takes the connection down with it.** The connect-time instructions
 *    now carry a live sketch of the context, which means a slow bucket, a
 *    revoked key, or a `privacy.md` somebody broke in Obsidian is suddenly on
 *    the path of the handshake. It must degrade to the static text, never fail.
 *
 * The shared suite's in-memory bucket returns every key in one page and ignores
 * `delimiter`, which is fine for privacy semantics and useless for both of the
 * above. This file therefore stands up its own bucket that paginates honestly
 * and collapses delimited prefixes the way R2 does.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`listBoundedKeys` given no page cap** (walk everything, never truncate).
 *    2 checks failed: the floor markers on the folder line and on its children.
 *    The *total* stayed honest, because a second folder here cannot be walked
 *    at all — which is why the floor has two independent causes and both are
 *    asserted.
 * 2. **The per-folder `try` widened to one outer `try`**, as it was in the
 *    first draft of the note census. 9 checks failed: one folder with a
 *    backslash in its name emptied the entire survey.
 * 3. **`instructionsForSession` allowed to throw** (the `catch` removed). 2
 *    checks failed — but only after the handshake check was tightened from
 *    "HTTP 200" to "carries a result". A thrown handler is answered with a
 *    JSON-RPC error object over HTTP 200, so the first version of that check called a
 *    client that could not connect a successful connection.
 * 4. **`classifyCaptureKind` made to always return `null`** (the recency
 *    collapse disabled). 13 of the 16 checks in "automated capture is not
 *    attention" failed, including — not merely the ones naming a collapsed
 *    line — "a hand-edited note still appears individually in the recency
 *    list": with nothing classified as automated, 31 mail days, 2 meetings and
 *    a saved session outrank every hand-edited note by raw timestamp and push
 *    all three out of `mostRecent`'s top 8, which is the exact failure this
 *    feature exists to close. The 3 that kept passing depend only on `canSee`
 *    excluding a private mailbox's notes from a team caller's *visible* list,
 *    a filter this change does not touch.
 */

import { createOrientationHarness } from "./orientation/fixtures.mjs";
import { runOrientationBudgetedWalkChecks } from "./orientation/budgetedWalk.test.mjs";
import { runOrientationSaveAndArchiveChecks } from "./orientation/saveAndArchive.test.mjs";
import { runOrientationConnectSketchChecks } from "./orientation/connectSketch.test.mjs";
import { runOrientationRecencyCollapseChecks } from "./orientation/recencyCollapse.test.mjs";
import { runOrientationShedSignalChecks } from "./orientation/shedSignal.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one large
 * function that built a single shared harness (a control-plane stub and
 * three in-memory buckets that page and delimit the way R2 does) and ran
 * every section against it in order — later sections read state (the
 * owner's own connect sketch, the buckets' seeded contents) an earlier one
 * left behind, so they cannot be reordered or given independent fixtures.
 *
 * It is now a thin facade over `test/orientation/*.test.mjs`, split by
 * responsibility, that builds that same harness once and threads it through
 * every section in its original order, so `import { runOrientationChecks }
 * from "./orientation.test.mjs"` keeps working unchanged and the checks run
 * exactly as they did before.
 */
export async function runOrientationChecks(check) {
  const harness = await createOrientationHarness();
  try {
    await runOrientationBudgetedWalkChecks(check, harness);
    await runOrientationSaveAndArchiveChecks(check, harness);
    await runOrientationConnectSketchChecks(check, harness);
    await runOrientationRecencyCollapseChecks(check, harness);
    await runOrientationShedSignalChecks(check, harness);
  } finally {
    harness.restore();
  }
}
