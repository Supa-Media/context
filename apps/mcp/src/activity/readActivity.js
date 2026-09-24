/** `read_activity` — the context's recent changes, filtered through `canSee`. */

import {
  ACTIVITY_PATH,
  describeEntry as describeActivityEntry,
  parseFile as parseActivityFile,
  visibleEntries as visibleActivityEntries,
} from "../../../../packages/shared/src/activity.cjs";
import { canSee } from "../privacy/engine.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { toolError, toolText } from "../tools/results.js";

/**
 * The viewing layer, for a caller that is not the file's owner.
 *
 * The file is private, so this is the only way a team-tier connection reads
 * any of it — and what it returns is built per caller: the event-time flag,
 * then `canSee` re-derived through the live manifest, then the prose. A line
 * somebody may not see is absent. It is never replaced by a placeholder and
 * never counted, because a gap a reader can count is the disclosure the flag
 * was there to prevent.
 */
export async function toolReadActivity(store, scope, rules, overrides, args) {
  const limit = Number.isInteger(args?.limit) ? args.limit : 30;
  if (limit < 1 || limit > 200) return toolError("limit must be between 1 and 200");
  const object = await getWithLegacyFallback(store, ACTIVITY_PATH);
  if (!object) {
    return toolText(
      "(no activity recorded yet — this context's activity file appears once something changes)",
    );
  }
  /*
    A LINE POINTS AT A NOTE, NOT AT A PATH IT ONCE HAD.

    An entry written on Tuesday names where the note was on Tuesday, and
    tidying a context on Thursday makes every one of those lines point at
    nothing. So each path is forwarded through the ledger `#735` added —
    `.context/forwarding.json`, the same trail a share link follows — before
    the line is drawn or filtered.

    Two consequences, both wanted. Following a row lands on the note rather
    than on a gone path; and `canSee` is asked about where the note *is*,
    so one moved into a private folder drops out of the lines written while
    it was shared, which is the direction that fails closed. The historical
    path is not lost: `.context/audit/` keeps it, and `list_changes` prints it.
  */
  const forwarding = await readForwarding(store);
  const forwarded = parseActivityFile(await object.text()).map((entry) => ({
    ...entry,
    paths: entry.paths.map((path) => forwardPath(forwarding, path)),
  }));
  const entries = visibleActivityEntries(forwarded, {
    owner: scope === "private",
    canSee: (path) => canSee(path, scope, rules, overrides),
  }).slice(0, limit);
  if (!entries.length) return toolText("(no visible activity)");
  return toolText(
    entries
      .map((entry) => {
        const summary = entry.note ? ` — ${entry.note}` : "";
        return `${entry.at} — ${describeActivityEntry(entry)}${summary}`;
      })
      .join("\n"),
  );
}
