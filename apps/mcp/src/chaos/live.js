/**
 * The chaos score counted at read time from the Convex tree's keys
 * (`docs/decisions/app-and-console/convex-tree.md`), for `orient` and for
 * what a write tells the agent that made it (`change.js`).
 *
 * The shape is the tree's own keys, folded through pending moves by whoever
 * listed them; only what the keys cannot say comes from the control plane's
 * facts (`tree/facts.js`): which notes are long, which are meetings or
 * generated, and which contact pages wait on review. Those are few, so they
 * are one small answer, never a row per note.
 *
 * Two audiences (`scoreFolder`, `treeShape`): the team numbers count only
 * what `visibleToTeam` passes, and a team reader is named a folder only where
 * a team note sits beneath it. A member counting notes held back from them
 * could learn those notes exist, which `privacy.md` exists to prevent.
 *
 * The search database's per-folder `tree_chaos` table and its daily history
 * that counted this first were retired in phase 7 (`tree/retired.js`); the
 * history is the control plane's now.
 */

import { LONG_NOTE_LINES, isArchived, scoreFolder, treeShape } from "./rubric.js";

/**
 * Every folder's numbers for both audiences, from the keys.
 *
 * @param {string[]} keys every key in the tree, as drawn now
 * @param {Map<string, { lines: number | null, exempt: boolean, review: boolean }>} extras
 * @param {(path: string) => boolean} visibleToTeam
 */
export function scoreKeys(keys, extras, visibleToTeam) {
  const rows = keys.map((path) => ({ path, ...(extras.get(path) ?? {}) }));
  const all = treeShape(rows);
  const team = treeShape(rows.filter((row) => visibleToTeam(row.path)));
  const folders = new Map();
  for (const [path, entry] of all) {
    if (isArchived(path)) continue;
    const teamEntry = team.get(path);
    const scoredAll = scoreFolder({ path, notes: entry.notes, folders: [...entry.folders] });
    const scoredTeam = teamEntry
      ? scoreFolder({ path, notes: teamEntry.notes, folders: [...teamEntry.folders] })
      : { items: 0, weight: 0, sum: 0 };
    folders.set(path, { all: scoredAll, team: scoredTeam, teamExists: teamEntry !== undefined });
  }
  return folders;
}

const ratio = (sum, weight) => (weight > 0 ? sum / weight : 0);

/**
 * Both audiences' whole-workspace score from `scoreKeys`, as `liveSummary`
 * counts the one it is asked for: what the daily history keeps.
 *
 * @param {ReturnType<typeof scoreKeys>} folders
 */
export function liveTotals(folders) {
  let allSum = 0;
  let allWeight = 0;
  let teamSum = 0;
  let teamWeight = 0;
  for (const entry of folders.values()) {
    allSum += entry.all.sum;
    allWeight += entry.all.weight;
    teamSum += entry.team.sum;
    teamWeight += entry.team.weight;
  }
  return { all: ratio(allSum, allWeight), team: ratio(teamSum, teamWeight) };
}

/** One folder's numbers for this audience, or null when it is not to be named to them. */
export function folderNumbers(folders, path, team) {
  const entry = folders.get(path);
  if (!entry || (team && !entry.teamExists)) return null;
  const numbers = team ? entry.team : entry.all;
  return { folder: path, items: numbers.items, chaos: ratio(numbers.sum, numbers.weight) };
}

/**
 * What `orient` reports: the score, the folders that would calm it most, and
 * the longest notes, counted from the keys.
 *
 * @param {ReturnType<typeof scoreKeys>} folders
 * @param {Map<string, { lines: number | null, exempt: boolean }>} extras
 * @param {{ team: boolean, present: Set<string>, visible: (path: string) => boolean, limit?: number, weekAgo?: number | null }} options
 *   `present` is every key in the tree now: a long note that has gone is not named.
 */
export function liveSummary(folders, extras, { team, present, visible, limit = 5, weekAgo = null }) {
  let sum = 0;
  let weight = 0;
  const ranked = [];
  for (const [path, entry] of folders) {
    const numbers = team ? entry.team : entry.all;
    sum += numbers.sum;
    weight += numbers.weight;
    if (team && !entry.teamExists) continue;
    if (numbers.weight > 0 && numbers.sum > 0) ranked.push({ path, numbers });
  }
  ranked.sort((a, b) => b.numbers.sum - a.numbers.sum || (a.path < b.path ? -1 : 1));
  const longNotes = [...extras]
    .filter(([path, extra]) => (extra.lines ?? 0) > LONG_NOTE_LINES && !extra.exempt && !isArchived(path) && present.has(path) && visible(path))
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 3)
    .map(([path, extra]) => ({ path, lines: Number(extra.lines) }));
  return {
    score: ratio(sum, weight),
    weekAgo,
    folders: ranked.slice(0, limit).map(({ path, numbers }) => ({
      folder: path,
      items: numbers.items,
      chaos: ratio(numbers.sum, numbers.weight),
      share: numbers.sum,
    })),
    longNotes,
  };
}
