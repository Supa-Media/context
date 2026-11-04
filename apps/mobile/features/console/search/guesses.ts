/**
 * What the search bar lists before anything is typed: its best guesses at the note the person wants next (the
 * search revamp, owner, 2026-11-04: "guess what users want", with no record of searches or opens kept).
 *
 * Read only from what is already stored: each of the person's recent rows (when they last opened it, when they last
 * typed in it, and one open count per note that fades by half every two weeks, `placeRecents.opens`), the note on
 * screen and the notes it links to, and the folder it is in. Nothing here is written anywhere.
 *
 * Pure, so the order is decided in one place a test can reach.
 */

import { indexByName, parseLinks, resolveLink } from "@context/shared/src/links";

/** One of the person's recent rows (`places.recentNotes`). */
export interface GuessRow {
  path: string;
  at: number;
  kind?: "opened" | "edited";
  editedAt?: number;
  /** The fading open count as of `at`; absent on rows from before it, which read as one open. */
  opens?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Matches `OPEN_HALF_LIFE_MS` in `apps/convex/functions/lib/places.ts`. */
export const OPEN_HALF_LIFE_MS = 14 * DAY_MS;
/** A note somebody was in a moment ago is the likeliest next one; that pull fades within a day. */
const JUST_NOW_HALF_LIFE_MS = 6 * HOUR_MS;
/** A note they wrote in this week is likelier than one they only read. */
const EDIT_HALF_LIFE_MS = 7 * DAY_MS;

/** What each signal is worth, in opens. */
export const WEIGHTS = { justNow: 2, edited: 1, linked: 2, sameFolder: 0.5 } as const;

const fade = (since: number, halfLife: number) => 0.5 ** (Math.max(0, since) / halfLife);

/** The row's open count as of `now`. */
export function openCount(row: GuessRow, now: number): number {
  const held = row.opens === undefined ? 1 : Number.isFinite(row.opens) ? Math.max(0, row.opens) : 0;
  return held * fade(now - row.at, OPEN_HALF_LIFE_MS);
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isNote = (path: string) => /\.[^./]+$/.test(path.slice(path.lastIndexOf("/") + 1));

/**
 * The notes the open note links to, as paths, in the order they appear. Only links that settle on a note in `paths`.
 */
export function linkedFrom(text: string | undefined, from: string, paths: readonly string[]): string[] {
  if (text === undefined || text === "") return [];
  const known = new Set(paths);
  const byName = indexByName(paths);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of parseLinks(text)) {
    let path: string | null = null;
    try {
      path = resolveLink(link, from, byName);
    } catch {
      path = null;
    }
    if (path === null || path === from || seen.has(path) || !known.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * The paths to list, best guess first.
 *
 * `openPath` is what is on screen: a note (left out, since they are already in it, and its links and folder count) or
 * a folder (its notes count). `openText` is that note's text when the app holds it; `paths` is every note the bar
 * knows, which a link must land on.
 */
export function guessOrder(options: {
  rows: readonly GuessRow[];
  now: number;
  openPath?: string | null;
  openText?: string;
  paths?: readonly string[];
}): string[] {
  const { rows, now } = options;
  const openPath = options.openPath ?? null;
  const onNote = openPath !== null && isNote(openPath);
  const folder = openPath === null ? null : onNote ? folderOf(openPath) : openPath;
  const linked = onNote ? linkedFrom(options.openText, openPath, options.paths ?? []) : [];
  const score = new Map<string, number>();
  const add = (path: string, value: number) => score.set(path, (score.get(path) ?? 0) + value);

  for (const row of rows) {
    if (row.path === openPath || !isNote(row.path)) continue;
    add(row.path, openCount(row, now) + WEIGHTS.justNow * fade(now - row.at, JUST_NOW_HALF_LIFE_MS));
    const editedAt = row.editedAt ?? (row.kind === "edited" ? row.at : undefined);
    if (editedAt !== undefined) add(row.path, WEIGHTS.edited * fade(now - editedAt, EDIT_HALF_LIFE_MS));
  }
  for (const path of linked) add(path, WEIGHTS.linked);
  if (folder !== null) {
    for (const path of score.keys()) if (folderOf(path) === folder) add(path, WEIGHTS.sameFolder);
  }

  const lastAt = new Map(rows.map((row) => [row.path, row.at]));
  const linkRank = new Map(linked.map((path, index) => [path, index]));
  return [...score.entries()]
    .sort(
      ([a, sa], [b, sb]) =>
        sb - sa ||
        (lastAt.get(b) ?? -Infinity) - (lastAt.get(a) ?? -Infinity) ||
        (linkRank.get(a) ?? Infinity) - (linkRank.get(b) ?? Infinity) ||
        (a < b ? -1 : a > b ? 1 : 0),
    )
    .map(([path]) => path);
}
