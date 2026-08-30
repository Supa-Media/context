/**
 * The pure model behind the palette — one widget, three item sources.
 *
 * The same ranked-list-over-a-query lives in three places in the console:
 *
 *  - the **⌘K command palette** on web, and the search button in the phone's
 *    bottom toolbar, which are the same sheet with different chrome;
 *  - the **⌘O quick switcher**, fuzzy over the note paths that are loaded;
 *  - **"Move to…"**, a filterable folder picker — the list `MovePicker` used
 *    to render whole, which stops being a list you can read at about thirty
 *    folders.
 *
 * They differ only in where the items come from, so the items are a plain
 * array and everything below is a function over it. No React, no react-native,
 * no DOM: the console's Jest suite runs in plain node (see `jest.config.js`),
 * and ranking is exactly the kind of rule that is impossible to check by
 * clicking around and trivial to pin in a test.
 *
 * ## Why the scoring rules are worth this much code
 *
 * This app serves a browser and a phone as equals. On the web this model backs
 * ⌘K and ⌘O; on a phone it backs a full-screen search sheet opened from the
 * bottom toolbar, and that is the harder case. A phone shows about six rows,
 * and nobody scrolls a fuzzy list on a touchscreen — they type another letter
 * or give up. So the bar is not "the right answer is in here somewhere", it is
 * **the first result is usually right**. Every rule below buys a specific case
 * where a naive subsequence match would have put the wrong note on top, and
 * each one is asserted in `__tests__/palette.test.ts`.
 *
 * ## This is not an index, and must never become one
 *
 * `CLAUDE.md`, non-negotiable 3: plain files stay canonical, and search
 * indexes and caches are **disposable derivatives, rebuildable from the files,
 * never the only copy of anything**. Nothing here caches across calls, holds
 * module-level mutable state, or persists anything — every function takes the
 * listings the browser has already loaded and returns a fresh array.
 *
 * "Memoize the index" is exactly the optimisation someone will reach for, and
 * it is the wrong shape twice over: it would make this module a store of note
 * names that outlives the request that loaded them (in a process that can hold
 * more than one workspace's data over its life), and it would rank notes that
 * are no longer there. Ranking a few thousand strings is microseconds. If it
 * ever is not, the fix is to rank fewer items, not to remember them.
 */

import { baseName, parentPath } from "./paths";
import type { FileEntry, FolderListing } from "./types";

export interface PaletteItem {
  id: string;
  /** What matched — the note name, the command name, the folder path. */
  label: string;
  /** Dimmer second line: the containing folder, or the command's shortcut. */
  detail?: string;
  kind: "note" | "folder" | "command";
}

export interface Match {
  item: PaletteItem;
  score: number;
  /**
   * Half-open `[start, end)` slices of `label` that matched, so the UI can
   * bold them: `label.slice(start, end)`. Ascending, non-overlapping, and
   * adjacent characters merged into one run.
   */
  ranges: readonly [number, number][];
}

/** How many rows the palette will ever hand its list. */
export const DEFAULT_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/*                                  scoring                                   */
/* -------------------------------------------------------------------------- */

/** Every matched character is worth something, so a longer match wins. */
const MATCH_BONUS = 16;

/**
 * A match at the start of a word.
 *
 * This is the one that makes this codebase's notes searchable at all: they are
 * all kebab-case (`together-financial-management.md`, `working-with-seyi.md`),
 * so the letters a person actually reaches for are the segment initials. `tfm`
 * has to find the first of those, and it only does if starting a segment is
 * worth more than landing mid-word.
 */
const BOUNDARY_BONUS = 16;

/**
 * Characters matched back-to-back.
 *
 * Worth strictly more than a boundary, because otherwise `proj` prefers
 * `p-r-o-j.md` — four boundary hits — over `projects.md`, which is the exact
 * inversion of what someone typing `proj` means.
 */
const CONSECUTIVE_BONUS = 24;

/**
 * A character matched in the last path segment.
 *
 * A query is nearly always aimed at the note, not the folder it sits in. Per
 * character rather than a flat bonus, so a long match in the basename still
 * beats a long match in the folder part.
 */
const BASENAME_BONUS = 8;

/** Opening a gap costs; widening it costs a little more, up to a point. */
const GAP_OPEN_PENALTY = 6;
const GAP_WIDTH_CAP = 8;

/**
 * Typing the whole name, or the start of it.
 *
 * Measured against the basename as well as the whole label, so a folder that
 * merely *starts* with the query does not outrank the note the query names.
 */
const PREFIX_BONUS = 80;
const EXACT_BONUS = 160;

/** Start of the string, or just after one of these. */
const WORD_BREAKS = new Set(["-", "_", "/", ".", " "]);

const NEG = Number.NEGATIVE_INFINITY;

/**
 * Case-folded, one entry per UTF-16 index.
 *
 * Per character rather than `text.toLowerCase()` because a whole-string
 * lowercase can change length (`"İ"` folds to two characters), and `ranges`
 * are indices into the caller's original string. A character that folds to two
 * simply fails to match, which is a miss rather than a wrong highlight.
 */
function foldCase(text: string): string[] {
  const folded = new Array<string>(text.length);
  for (let index = 0; index < text.length; index += 1) {
    folded[index] = text.charAt(index).toLowerCase();
  }
  return folded;
}

function isBoundary(folded: readonly string[], index: number): boolean {
  return index === 0 || WORD_BREAKS.has(folded[index - 1]);
}

function characterScore(
  folded: readonly string[],
  index: number,
  consecutive: boolean,
  lastSlash: number,
): number {
  let score = MATCH_BONUS;
  if (isBoundary(folded, index)) score += BOUNDARY_BONUS;
  if (consecutive) score += CONSECUTIVE_BONUS;
  if (index > lastSlash) score += BASENAME_BONUS;
  return score;
}

function gapPenalty(skipped: number): number {
  if (skipped <= 0) return 0;
  return -(GAP_OPEN_PENALTY + Math.min(skipped - 1, GAP_WIDTH_CAP));
}

/** Typed the whole thing, or the start of it — on the label or its basename. */
function anchorBonus(query: string, text: string): number {
  const needle = query.toLowerCase();
  const whole = text.toLowerCase();
  const base = baseName(text).toLowerCase();
  if (whole === needle || base === needle) return EXACT_BONUS;
  if (whole.startsWith(needle) || base.startsWith(needle)) return PREFIX_BONUS;
  return 0;
}

function mergeRanges(indices: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/**
 * Subsequence fuzzy match, case-insensitive. `null` when it does not match.
 *
 * `tgf` matches `together-financial.md`; `gft` does not, because a subsequence
 * is in order. Where a query could match in more than one place — `proj` in
 * `1-projects/proj-notes.md` — this finds the **best-scoring** placement
 * rather than the leftmost one, which is the difference between highlighting
 * the folder and highlighting the note. That is a small dynamic program over
 * (query character, label index); labels are paths, so it is tiny.
 */
export function fuzzyMatch(
  query: string,
  text: string,
): { score: number; ranges: readonly [number, number][] } | null {
  const needle = foldCase(query);
  const haystack = foldCase(text);
  const queryLength = needle.length;
  const textLength = haystack.length;

  // An empty query is a subsequence of everything, and highlights nothing.
  if (queryLength === 0) return { score: 0, ranges: [] };
  if (queryLength > textLength) return null;

  const lastSlash = text.lastIndexOf("/");

  // best[i][j]: the best score for matching query[0..i] with query[i] landing
  // on text[j]. from[i][j]: where query[i - 1] landed in that best run.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < queryLength; i += 1) {
    best.push(new Array<number>(textLength).fill(NEG));
    from.push(new Array<number>(textLength).fill(-1));
  }

  for (let j = 0; j <= textLength - queryLength; j += 1) {
    if (haystack[j] === needle[0]) {
      best[0][j] = characterScore(haystack, j, false, lastSlash);
    }
  }

  for (let i = 1; i < queryLength; i += 1) {
    for (let j = i; j < textLength; j += 1) {
      if (haystack[j] !== needle[i]) continue;
      let bestHere = NEG;
      let bestFrom = -1;
      for (let previous = i - 1; previous < j; previous += 1) {
        const carried = best[i - 1][previous];
        if (carried === NEG) continue;
        const total =
          carried +
          gapPenalty(j - previous - 1) +
          characterScore(haystack, j, previous === j - 1, lastSlash);
        if (total > bestHere) {
          bestHere = total;
          bestFrom = previous;
        }
      }
      best[i][j] = bestHere;
      from[i][j] = bestFrom;
    }
  }

  let endIndex = -1;
  let endScore = NEG;
  for (let j = queryLength - 1; j < textLength; j += 1) {
    if (best[queryLength - 1][j] > endScore) {
      endScore = best[queryLength - 1][j];
      endIndex = j;
    }
  }
  if (endIndex < 0) return null;

  const indices: number[] = [];
  let i = queryLength - 1;
  let j = endIndex;
  while (i >= 0 && j >= 0) {
    indices.push(j);
    j = from[i][j];
    i -= 1;
  }
  indices.reverse();

  return { score: endScore + anchorBonus(query, text), ranges: mergeRanges(indices) };
}

/**
 * Best first, and the same order every time.
 *
 * Determinism is not tidiness here: a list that reorders between keystrokes
 * while a finger is on its way down is unusable, and on a phone the row under
 * the finger is the whole interaction. Score, then shorter label, then
 * alphabetical, then id — a total order, so the result never depends on the
 * sort being stable or on which folder happened to load first.
 */
function compareMatches(left: Match, right: Match): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.item.label.length !== right.item.label.length) {
    return left.item.label.length - right.item.label.length;
  }
  if (left.item.label !== right.item.label) return left.item.label < right.item.label ? -1 : 1;
  if (left.item.id === right.item.id) return 0;
  return left.item.id < right.item.id ? -1 : 1;
}

/**
 * Rank `items` against `query`, best first, capped at `limit`.
 *
 * An empty query returns the items **in their input order**, unfiltered and
 * unsorted — that is what an opened-but-untyped palette shows, and sorting it
 * would mean the list jumps the moment the first character arrives from a
 * different arrangement than it started in.
 *
 * The cap is applied after ranking, never before: `limit` is how many rows the
 * list draws, not how many candidates are worth considering.
 */
export function rank(
  query: string,
  items: readonly PaletteItem[],
  limit: number = DEFAULT_LIMIT,
): Match[] {
  const trimmed = query.trim();
  const cap = Math.max(0, limit);

  if (trimmed === "") {
    return items.slice(0, cap).map((item) => ({ item, score: 0, ranges: [] }));
  }

  const matches: Match[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(trimmed, item.label);
    if (hit === null) continue;
    matches.push({ item, score: hit.score, ranges: hit.ranges });
  }
  matches.sort(compareMatches);
  return matches.slice(0, cap);
}

/* -------------------------------------------------------------------------- */
/*                                item sources                                */
/* -------------------------------------------------------------------------- */

/**
 * Folder paths in a stable order, whatever order they loaded in.
 *
 * The console fetches one folder at a time, so `listings`' key order is the
 * order somebody clicked. Sorting here is what makes "input order" — which is
 * what an untyped palette shows — mean something.
 */
function knownFolderPaths(
  listings: Readonly<Record<string, FolderListing | undefined>>,
): string[] {
  return Object.keys(listings).sort();
}

/**
 * What a folder is known to contain — nothing, if its listing has not landed.
 *
 * The `?.` is the whole of "only what is actually loaded". An expanded folder
 * whose fetch is still in flight is a present key with an `undefined` value,
 * and the palette must say less about it rather than more: a row for a note it
 * has not seen would be a row that cannot be opened.
 */
function entriesOf(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  folder: string,
): readonly FileEntry[] {
  return listings[folder]?.entries ?? [];
}

/**
 * Every loaded note and folder as palette items.
 *
 * **Only what is actually loaded.** A folder that is expanded but whose
 * listing has not arrived is `undefined` and contributes nothing — the palette
 * says less rather than inventing rows, the same way the tree draws a loading
 * row instead of an empty one.
 */
export function itemsFromListings(
  listings: Readonly<Record<string, FolderListing | undefined>>,
): PaletteItem[] {
  const items = new Map<string, PaletteItem>();
  for (const folder of knownFolderPaths(listings)) {
    for (const entry of entriesOf(listings, folder)) {
      if (items.has(entry.path)) continue;
      items.set(
        entry.path,
        entry.kind === "folder"
          ? { id: entry.path, label: entry.path, kind: "folder" }
          : {
              id: entry.path,
              label: entry.name,
              detail: parentPath(entry.path) === "" ? "/" : parentPath(entry.path),
              kind: "note",
            },
      );
    }
  }
  return [...items.values()];
}

/**
 * Folder destinations for "Move to…".
 *
 * The root is a real destination, labelled `/` — notes do live there, and a
 * picker that cannot name the root cannot undo a move into a folder.
 *
 * `movingPath` drops itself and everything under it, because a folder cannot
 * move inside itself. That is the same refusal `describeMoveProblem` makes,
 * done a step earlier: a destination that would be rejected should not be
 * offered. Pass `null` — moving nothing, or picking a folder for some other
 * reason — to get every loaded folder.
 *
 * `id` is the destination folder path, exactly what `FileBrowser.move` takes,
 * so the root's id is `""`.
 */
export function folderItems(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  movingPath: string | null,
): PaletteItem[] {
  const folders = new Set<string>([""]);
  for (const folder of knownFolderPaths(listings)) {
    for (const entry of entriesOf(listings, folder)) {
      if (entry.kind === "folder") folders.add(entry.path);
    }
  }

  const items: PaletteItem[] = [];
  for (const path of [...folders].sort()) {
    if (movingPath !== null && (path === movingPath || path.startsWith(`${movingPath}/`))) {
      continue;
    }
    items.push(
      path === ""
        ? { id: "", label: "/", detail: "the root of your context", kind: "folder" }
        : { id: path, label: path, kind: "folder" },
    );
  }
  return items;
}
