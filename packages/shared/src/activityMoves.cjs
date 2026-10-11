/**
 * The `[from, to]` pairs a `moved` or `archived` line in `activity.md` carries, for the
 * console map's replay. Split out of `activity.cjs`, which builds, merges,
 * decodes and filters lines through these four.
 *
 * `paths` cannot say where a move went: a bulk move keeps only the
 * destinations, a grouped line mixes several moves, and every reader forwards
 * `paths` to where the note is *now*, which turns `[from, to]` into `[to, to]`
 * the moment it is read. The pairs are history and are **never forwarded** —
 * which is why `visibleMoves` asks about both ends of each one again rather
 * than trusting that `paths` passed. A folder move's pair names two folders
 * (no `.md`), exactly as its `paths` do.
 *
 * Absent rather than empty when there is nothing to say: every line written
 * before the field existed reads as "no pairs", and so does a cross-context
 * move, whose other end is in another bucket.
 */

/** As many pairs as a line keeps paths (`MAX_ENTRY_PATHS`). */
const MAX_MOVE_PAIRS = 5;

/** The pairs one change produces: `move_notes` interleaves, the rest name one. */
function movePairsOf(action, touched) {
  const pairs = [];
  if (action === "move_notes") {
    for (let index = 0; index + 1 < touched.length; index += 2) {
      pairs.push([touched[index], touched[index + 1]]);
    }
  } else if (touched.length >= 2) {
    pairs.push([touched[0], touched[1]]);
  }
  return pairs.slice(0, MAX_MOVE_PAIRS);
}

/** Pairs merged onto an existing line, oldest first, distinct, capped. */
function mergeMoves(existing, added) {
  const out = [];
  const seen = new Set();
  for (const pair of (existing || []).concat(added || [])) {
    const key = `${pair[0]}\u0000${pair[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out.slice(0, MAX_MOVE_PAIRS);
}

/**
 * The stored pairs, validated. A malformed pair is dropped, never the line:
 * the pairs are a replay's detail, and the sentence stands without them.
 */
function decodeMoves(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((path) => typeof path === "string" && path !== ""),
    )
    .slice(0, MAX_MOVE_PAIRS)
    .map((pair) => [pair[0], pair[1]]);
}

/**
 * A line as one reader below owner may have it: every pair whose two ends
 * that reader may see now, and no `moves` field at all when none survive.
 * The line itself is kept — its forwarded `paths` already cleared it.
 */
function visibleMoves(entry, canSee) {
  if (!entry.moves) return entry;
  const moves = entry.moves.filter((pair) => canSee(pair[0]) && canSee(pair[1]));
  const kept = { ...entry, moves };
  if (!moves.length) delete kept.moves;
  return kept;
}

module.exports = { MAX_MOVE_PAIRS, decodeMoves, mergeMoves, movePairsOf, visibleMoves };
