/**
 * The viewing layer over `activity.md`: which lines one reader may see, and
 * which of them are new to that reader. Split out of `activity.cjs`, which
 * re-exports all three and holds the rules for building and storing lines.
 */

const { visibleMoves } = require("./activityMoves.cjs");

/**
 * The entries a given reader may see.
 *
 * Two independent gates, and a change has to pass both:
 *
 *  1. **What was decided when it happened.** `vis` is the same immutable
 *     event-time flag `list_changes` reads, so a note that was private when it
 *     changed never becomes reportable later.
 *  2. **What the manifest says now.** `canSee` is re-derived per path at read
 *     time, so a note taken back into private disappears from the rendering
 *     for everyone who lost it, including from lines written while it was
 *     shared.
 *
 * `owner` skips both, because the file is the owner's own record and they can
 * read it as a note in any case.
 */
function visibleEntries(entries, options) {
  const { owner, canSee } = options || {};
  if (owner) return entries.slice();
  return entries
    .filter((entry) => {
      if (entry.vis !== "team") return false;
      if (typeof canSee !== "function") return false;
      return entry.paths.every((path) => canSee(path));
    })
    // A pair is history, never forwarded, so `paths` passing says nothing
    // about it: the folder a note left can have been made private since.
    .map((entry) => visibleMoves(entry, canSee));
}

/** How many of these are newer than the reader's last visit. */
function unseenCount(entries, seenAt) {
  const since = Number(seenAt);
  if (!Number.isFinite(since) || since <= 0) return entries.length;
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at > since;
  }).length;
}

/**
 * The paths a reader has not caught up with, for the dots in the file tree.
 *
 * Notes only, and folders are the caller's job: the tree knows which of its
 * rows are collapsed and this does not.
 */
function unseenPaths(entries, seenAt) {
  const since = Number(seenAt);
  const paths = new Set();
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(since) && since > 0 && (!Number.isFinite(at) || at <= since)) {
      continue;
    }
    for (const path of entry.paths) paths.add(path);
  }
  return paths;
}

module.exports = { unseenCount, unseenPaths, visibleEntries };
