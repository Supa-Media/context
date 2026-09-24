/**
 * Phase 2 of `docs/decisions/communications.md`, "Search must index messages,
 * and today's index cannot": a channel-day note indexed as one sub-document
 * per message anchor (`src/search/commsIndex.js`), against
 * `src/search/CONTRACT.md`'s "Channel-day notes: one sub-document per
 * message".
 *
 * Four properties, each with its own section below:
 *
 * 1. **Recall reaches the last message of a large day** — the check
 *    `docs/decisions/communications.md` names as the one that will matter —
 *    proved by putting the interesting word in the LAST message of a day
 *    whose combined text is many times `NOTE_INDEX_CHAR_CAP`, and finding it.
 * 2. **`canSee` runs on the containing note, never per message**: the same
 *    message text in a private day and a team day, and only the team hit
 *    returns; two workspaces holding the identical message text, and a
 *    search in one never surfaces the other's shard.
 * 3. **Encrypted notes teach the index no plaintext term** (the phase-1
 *    rule), carried through to sub-documents rather than only to whole notes.
 * 4. **Regenerating one channel-day note replaces exactly its
 *    sub-documents** — proved with two days in the same shard, one of them
 *    edited down, the other untouched.
 *
 * The adversarial review's own sections are at the bottom of the file, each
 * naming the claim it attacks: the two visibility guards driven one at a
 * time, the existence oracle, a cross-workspace key collision, a shard
 * constructed in the pre-change shape, a rebuild compared against an
 * incremental update, the no-message fallback, and the shard budget.
 *
 * ## Sabotage record
 *
 * Each broken deliberately as a local edit and reverted; counts are whole-suite
 * (`pnpm test`) against the final fixtures in this file. The right-hand
 * column is the review's re-measurement; where it differs from the number
 * the change was written with, the difference is the checks added below.
 *
 *   `isVisible` in `collectShardCandidates` checked against the sub-document's
 *     own key instead of `doc.notePath`                          2 -> 6
 *   `rankedVisibleTo` filtering on `entry.path` instead of
 *     `entry.notePath ?? entry.path` (the second guard)          2 -> 7
 *     — and the two it reddened before were both "the answer went
 *     empty", not "the private note leaked": nothing distinguished
 *     the guard working from the guard being unnecessary until
 *     `runGuardIndependenceChecks` drove each guard alone.
 *   `docVersionsOf` keyed by the doc's own key instead of `notePath`
 *     (the diff never converges: every pass re-fetches every channel-day
 *     note it has already indexed)                               1 -> 1
 *   `removeDocsForNote` replaced with the old per-key `removeDoc` in the
 *     regeneration path (a removed message's sub-document survives) 1 -> 7
 *   the independent per-message cap replaced with the whole-file cap
 *     applied before splitting (the last message of a large day is
 *     dropped, reproducing the bug this file exists to fix)      1 -> 10
 *   `subDocumentsFor` answering `[]` again for a channel-day file with no
 *     message headings (an encrypted day, a hand-written note)        5
 *   the anchor split removed from `read_note` and the ChatGPT dialect's
 *     `fetch`, so a search hit's key is not a key either accepts        4
 *     (in `test.mjs`, where the round trip is asserted against the
 *     real worker)
 *
 * This file used to hold every one of these checks directly, in one
 * 1,838-line function. It is now a thin facade over
 * `test/commsSearchIndex/*.test.mjs`, split by topic, so
 * `import { runCommsSearchIndexChecks } from "./commsSearchIndex.test.mjs"`
 * keeps working unchanged and every check still runs in its original order.
 */

import { runCommsSubDocumentChecks } from "./commsSearchIndex/subDocuments.test.mjs";
import {
  runCommsGuardIndependenceChecks,
  runCommsRegenerationChecks,
  runCommsSyncLoopChecks,
  runCommsVisibilityChecks,
} from "./commsSearchIndex/syncAndVisibility.test.mjs";
import {
  runCommsExistenceOracleChecks,
  runCommsLegacyIndexChecks,
  runCommsTenantCollisionChecks,
} from "./commsSearchIndex/oracleCollisionLegacy.test.mjs";
import {
  runCommsNoMessageFallbackChecks,
  runCommsRebuildChecks,
} from "./commsSearchIndex/rebuildAndFallback.test.mjs";
import { runCommsShardSizingChecks } from "./commsSearchIndex/shardSizing.test.mjs";

export async function runCommsSearchIndexChecks(check) {
  await runCommsSubDocumentChecks(check);
  await runCommsSyncLoopChecks(check);
  await runCommsVisibilityChecks(check);
  await runCommsRegenerationChecks(check);
  await runCommsGuardIndependenceChecks(check);
  await runCommsExistenceOracleChecks(check);
  await runCommsTenantCollisionChecks(check);
  await runCommsLegacyIndexChecks(check);
  await runCommsRebuildChecks(check);
  await runCommsNoMessageFallbackChecks(check);
  await runCommsShardSizingChecks(check);
}
