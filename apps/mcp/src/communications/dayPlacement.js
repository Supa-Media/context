// Where a day's note goes when the bucket already holds one for that day.
//
// The dated tree (`<folder>/YYYY/MM/YYYY-MM-DD.md`) arrived on 2026-09-18 and
// the change is forward-only: nothing already written is moved, because the
// notes are the customer's and moving a year of them is `move_folder`'s job
// and their decision (`docs/decisions/communications.md`).
//
// Forward-only has one edge that is not cosmetic. A day is **regenerated**,
// not appended to — every pass renders the whole day from its own
// contributions and writes it — so a day that already exists flat and is
// written nested does not continue anywhere: it exists twice, under one date,
// in two places. Both copies parse as the same day, so `list_channel_days`
// lists it twice, search indexes both, and the Contact page that links the
// morning's mail points at the copy that stopped growing.
//
// So the rule is: **a day that already has a note keeps it**, and only a day
// this bucket has never seen is filed in the tree. The switch therefore lands
// on a date boundary per day rather than per deploy, and a bucket that was
// synced yesterday has no seam at all — yesterday goes on being yesterday's
// file, today is the first one filed under its month.
//
// The check costs one `get` on a day whose flat note is absent, which is every
// day from the second week onward. It is not cached deliberately: a person who
// moves a day's note in Obsidian while a pass is running should have the next
// pass see what is actually in the bucket, not what was there when the Worker
// started.

import { flatDayPath } from "../../../../packages/communications/src/paths.js";

/*
  `flatDayPath` is the package's — the desktop app needs the same answer for
  iMessage and cannot import a Worker module, and two implementations of "what
  would this key have been before the tree" is how one of them ends up the
  looser one.
*/
export { flatDayPath };

/**
 * Where these parts of one day actually go.
 *
 * Decided once, off part 1, and applied to every part: a day that splits after
 * the switch must not leave part 1 flat and part 2 in the tree, which is the
 * same day in two folders by a different route.
 *
 * @template {{path: string}} Part
 * @param {{get: (key: string) => Promise<unknown>}} store
 * @param {readonly Part[]} parts
 * @returns {Promise<Part[]>}
 */
export async function placeDayParts(store, parts) {
  const list = [...parts];
  if (list.length === 0) return list;
  const flat = flatDayPath(list[0].path);
  if (flat === null) return list;
  const existing = await store.get(flat);
  if (!existing) return list;
  return list.map((part) => ({ ...part, path: flatDayPath(part.path) ?? part.path }));
}

/**
 * The same question for a channel that writes one file per day — a calendar
 * day, which never splits into parts.
 *
 * @param {{get: (key: string) => Promise<unknown>}} store
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function placeDayNote(store, path) {
  const flat = flatDayPath(path);
  if (flat === null) return path;
  const existing = await store.get(flat);
  return existing ? flat : path;
}
