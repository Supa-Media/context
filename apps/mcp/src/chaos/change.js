/**
 * What one change did to the chaos score, counted from the Convex tree.
 *
 * The owner's ask (2026-10-10): every write and move answers with the score
 * before and after and the folders it touched (`report.js`). The search
 * database's `tree_chaos` table counted that by rescoring the folders a change
 * named; it was retired in phase 7 of
 * `docs/decisions/app-and-console/convex-tree.md` (`tree/retired.js`), so the
 * same answer is counted here from the tree's keys and facts instead.
 *
 * ## Before, then after, from one read
 *
 * `announceTreeChange` (`activity/record.js`) tells the control plane about a
 * change only once this has answered, so the keys the tree hands back now are
 * the keys from before the change. The after is those keys with the change
 * applied in memory: a note written is added, a moved note or folder carries
 * its keys to the new path. Applying it is idempotent, so a tree that has
 * already heard (another tab, a sweep) makes before and after agree rather
 * than counting the change twice. A note that has since gone from the bucket
 * is not checked for: this is a report on one change, not a sweep.
 *
 * What the keys cannot say comes from the facts (`tree/facts.js`), with the
 * notes this change wrote read again for their length, so the long-note rule
 * is never a save behind for the agent that just wrote one, and a moved note
 * keeps the length it had.
 *
 * ## Who is told what
 *
 * The keys are the grant's own (`tree/served.js`), and both audiences are
 * counted as `orient` counts them (`live.js`): the team numbers over what the
 * team may open, from the live `privacy.md`. `chaosLines` then never names a
 * folder to a team reader that holds nothing the team can open.
 *
 * Never throws, and answers `null` wherever the tree does not serve this call
 * or its facts cannot answer; the write's answer then says nothing about the
 * score. The caller bounds the wait (`WAIT_MS`).
 */

import { canSee } from "../privacy/engine.js";
import { loadPrivacyState } from "../privacy/state.js";
import { factChaos } from "../tree/facts.js";
import { propsOf } from "../tree/props.js";
import { servedListingStore } from "../tree/served.js";
import { extrasAtTreeNames, liveTotals, scoreKeys } from "./live.js";
import { hasReview, isArchived, isExempt, parentOf } from "./rubric.js";

/**
 * The recorded actions of the tools whose answers carry the score
 * (`CHAOS_TOOLS`, `report.js`): only these are counted, since reading the
 * tree's keys for a change nobody is told about is cost with nothing to show.
 */
export const CHAOS_ACTIONS = new Set(["create_note", "move_note", "move_notes", "move_folder", "archive_note"]);

/** Notes one change reads again for their length. */
export const REFRESH_NOTES = 20;

/** Folders one report names at most; `chaosLines` shows four of them. */
export const REPORT_FOLDERS = 40;

/** A path as the bucket spells it, or null for nothing or plumbing. */
function clean(value) {
  if (typeof value !== "string") return null;
  const path = value.replace(/^\/+|\/+$/g, "");
  if (path === "" || path.split("/").some((part) => part.startsWith("."))) return null;
  return path;
}

const isNote = (path) => path.toLowerCase().endsWith(".md");

/** `[from, to]` pairs, cleaned, each end a real path and the two different. */
function movesOf(touch) {
  const pairs = [];
  for (const pair of Array.isArray(touch?.moves) ? touch.moves : []) {
    const from = clean(pair?.[0]);
    const to = clean(pair?.[1]);
    if (from !== null && to !== null && from !== to) pairs.push([from, to]);
  }
  return pairs;
}

/** The notes a change wrote in place: `files`, and any note it named that is not a move's end. */
function writtenOf(touch, moves) {
  const moved = new Set(moves.flat());
  const written = [];
  for (const value of [...(touch?.files ?? []), ...(touch?.paths ?? [])]) {
    const path = clean(value);
    if (path !== null && isNote(path) && !moved.has(path) && !written.includes(path)) written.push(path);
  }
  return written;
}

/** Each key under a move's source at its destination: the note itself, or a folder's keys. */
function carried(key, moves) {
  let path = key;
  for (const [from, to] of moves) {
    if (path === from) path = to;
    else if (path.startsWith(`${from}/`)) path = `${to}/${path.slice(from.length + 1)}`;
  }
  return path;
}

/**
 * The keys after this change, from the keys before it. Idempotent: a change
 * already applied changes nothing.
 *
 * @param {string[]} keys
 * @param {{ paths?: string[], files?: string[], moves?: [string, string][] }} touch
 */
export function keysAfterChange(keys, touch) {
  const moves = movesOf(touch);
  const after = new Set(keys.map((key) => carried(key, moves)));
  for (const path of writtenOf(touch, moves)) after.add(path);
  return [...after];
}

/** The facts' extras with each moved note's carried to where it went. */
function extrasAfterMoves(extras, moves) {
  if (moves.length === 0) return new Map(extras);
  const after = new Map();
  for (const [path, extra] of extras) after.set(carried(path, moves), extra);
  return after;
}

/** What the rubric needs of one note's text (`rubric.js`), read again from the bucket. */
async function readExtra(store, path) {
  const object = await store.get(path);
  if (!object) return null;
  const props = propsOf(await object.text());
  if (props === null) return { lines: null, exempt: false, review: false };
  return {
    lines: Number.isFinite(props.lines) ? props.lines : null,
    exempt: isExempt(path, props.properties?.type, props.properties?.generated),
    review: hasReview(props.properties?.review),
  };
}

/** The notes this change wrote, read for their length; one that cannot be read keeps what the facts said. */
async function writtenExtras(store, paths) {
  if (typeof store?.get !== "function") return new Map();
  const read = await Promise.all(
    paths.slice(0, REFRESH_NOTES).map(async (path) => {
      try {
        return [path, await readExtra(store, path)];
      } catch {
        return [path, null];
      }
    }),
  );
  return new Map(read.filter(([, extra]) => extra !== null));
}

/** One folder's numbers in the shape `chaosLines` reads, or null where it does not exist. */
function rowOf(folders, folder) {
  const entry = folders.get(folder);
  if (!entry) return null;
  return {
    folder,
    items: entry.all.items,
    weight: entry.all.weight,
    sum: entry.all.sum,
    team_exists: entry.teamExists ? 1 : 0,
    team_items: entry.team.items,
    team_weight: entry.team.weight,
    team_sum: entry.team.sum,
  };
}

/**
 * The folders a change touched, as the table's rescore chose them: a folder
 * the change named, each named path's parent, and up from there while a
 * folder appeared or vanished (for everyone, or for the team), because only
 * that changes its parent's item count.
 */
function touchedFolders(named, before, after) {
  const chosen = [];
  const add = (folder) => {
    if (!chosen.includes(folder)) chosen.push(folder);
  };
  const queue = [];
  for (const path of named) {
    if (isArchived(path)) continue;
    if (before.has(path) || after.has(path)) add(path);
    queue.push(parentOf(path));
  }
  const seen = new Set();
  while (queue.length > 0 && chosen.length < REPORT_FOLDERS) {
    const folder = queue.shift();
    if (seen.has(folder) || isArchived(folder)) continue;
    seen.add(folder);
    add(folder);
    const was = before.get(folder);
    const now = after.get(folder);
    const appeared = (was === undefined) !== (now === undefined);
    const teamChanged = (was?.teamExists === true) !== (now?.teamExists === true);
    if (folder !== "" && (appeared || teamChanged)) queue.push(parentOf(folder));
  }
  return chosen.slice(0, REPORT_FOLDERS);
}

/**
 * What a change did to the score, or null where the tree cannot say.
 *
 * @param {object} store the session's store, before the control plane has heard of the change
 * @param {{ paths?: string[], files?: string[], moves?: [string, string][] } | null} touch what the change named (`treeTouchOf`)
 * @returns {Promise<null | {
 *   before: { all: number, team: number },
 *   after: { all: number, team: number },
 *   folders: { folder: string, before: object | null, after: object | null }[],
 * }>} each folder's `before` and `after` is `{ folder, items, weight, sum, team_exists, team_items, team_weight, team_sum }`
 */
export async function changeChaos(store, touch) {
  if (!touch || typeof store?.treeFacts !== "function") return null;
  try {
    const listing = servedListingStore(store);
    if (typeof listing.treeKeys !== "function") return null;
    const moves = movesOf(touch);
    const written = writtenOf(touch, moves);
    const [keys, facts, state, rewritten] = await Promise.all([
      listing.treeKeys(),
      factChaos(store),
      loadPrivacyState(store),
      writtenExtras(store, written),
    ]);
    if (keys === null || facts === null || !state || state.error) return null;
    const visibleToTeam = (path) => canSee(path, "team", state.rules, state.overrides);
    // The facts name notes by bucket key; the keys are drawn through pending moves.
    const filed = extrasAtTreeNames(facts.extras, store.pendingMoves);
    const extrasAfter = extrasAfterMoves(filed, moves);
    for (const [path, extra] of rewritten) extrasAfter.set(path, extra);
    const before = scoreKeys(keys, filed, visibleToTeam);
    const after = scoreKeys(keysAfterChange(keys, touch), extrasAfter, visibleToTeam);
    const named = [];
    for (const value of [...(touch.paths ?? []), ...(touch.files ?? []), ...moves.flat()]) {
      const path = clean(value);
      if (path !== null && !named.includes(path)) named.push(path);
    }
    return {
      before: liveTotals(before),
      after: liveTotals(after),
      folders: touchedFolders(named, before, after).map((folder) => ({
        folder,
        before: rowOf(before, folder),
        after: rowOf(after, folder),
      })),
    };
  } catch {
    return null;
  }
}
