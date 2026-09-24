/**
 * `activity.md` — the feed, as a file.
 *
 * Two halves, for the two things that can be wrong with it.
 *
 * The **pure** half is the format and the filter: what becomes a line, what
 * never does, what merges into a line that is already there, and whether a
 * file written by one version can be read back by the next. That last one is
 * the property a rendering layer over a stored document lives or dies by, so
 * the round trip is asserted on every shape an entry can take — including the
 * two that can close an HTML comment early and take the rest of the history
 * with them.
 *
 * The **wired** half stands up a worker over its own bucket and proves the
 * three claims that are not about formatting at all:
 *
 *  1. Writing a note through the gateway leaves a line in `activity.md`.
 *  2. That file is stored **private**, whatever the folder it sits in says,
 *     because it names paths across the whole context.
 *  3. A team-tier caller reading it through `read_activity` sees the team
 *     lines and nothing else — not a placeholder, not a count, not a gap.
 *  4. What the gateway tells the control plane when a line lands is one
 *     workspace id and the line's tier — it is only told when a line actually
 *     landed, and a private line is reported as private so that no member's
 *     dot can carry the time of a change they may not see.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across this
 * suite.
 *
 *   `entryFor` returning an entry for every action                          9
 *   `MIN_REVISION_BYTES` set to 0                                           3
 *   the `isQuietPath` guard dropped from `entryFor`                         4
 *   `applyEntry` always unshifting (never merging)                          6
 *   the `REFRESH_MS` early return removed                                   1
 *   `encodeEntry`'s hyphen escape removed                                   2
 *   `visibleEntries` trusting `vis` without `canSee`                        2
 *   `visibleEntries` trusting `canSee` without `vis`                        1
 *   the private ACL dropped from the gateway's activity write               1
 *   `read_activity` serving the owner's view to a team caller               3
 *   the control-plane report dropped from `recordActivity`                  2
 *   the write's summary added to the report body                           2
 *   the report moved above the "nothing to say" return                      1
 *   `teamVisible` hard-coded true in `reportActivity`                       2
 */

import { runActivitySubstanceChecks } from "./activity/substance.test.mjs";
import { runActivityShapingChecks } from "./activity/shaping.test.mjs";
import { runActivityGroupingChecks } from "./activity/grouping.test.mjs";
import { runActivityCheapPathChecks } from "./activity/cheapPath.test.mjs";
import { runActivityRoundTripChecks } from "./activity/roundTrip.test.mjs";
import { runActivityFileIdentityChecks } from "./activity/fileIdentity.test.mjs";
import { runActivityVisibilityAndUnreadChecks } from "./activity/visibilityAndUnread.test.mjs";
import { runActivityWiredChecks } from "./activity/wired.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one large
 * function ("the pure half") that ran in sequence and finished by calling a
 * second function ("the wired half") over its own bucket and control plane.
 * It is now a thin facade over `test/activity/*.test.mjs`, split by
 * responsibility, that calls each section in its original order — visibility
 * and unread share a `mixed` history built once, so those two stay together
 * — so `import { runActivityChecks } from "./activity.test.mjs"` keeps
 * working unchanged and the checks run exactly as they did before.
 */
export async function runActivityChecks(check) {
  await runActivitySubstanceChecks(check);
  await runActivityShapingChecks(check);
  await runActivityGroupingChecks(check);
  await runActivityCheapPathChecks(check);
  await runActivityRoundTripChecks(check);
  await runActivityFileIdentityChecks(check);
  await runActivityVisibilityAndUnreadChecks(check);
  await runActivityWiredChecks(check);
}
