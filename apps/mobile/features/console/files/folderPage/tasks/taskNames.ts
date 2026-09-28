/**
 * What a new task's file is called, and which names a folder already uses.
 *
 * A task typed as "Order the coffee beans" is written to
 * `Order the coffee beans.md`: the title is the name, the rule the console
 * already keeps for every other note (`linkedTitle.ts`), so renaming the task
 * from its page renames the file with it. What cannot be a name is taken out
 * rather than refused, because a task title is a sentence somebody typed, not
 * a file name they chose:
 *
 * - a slash or a backslash would make a folder (`../x` climbs out of the
 *   project), so both become spaces, with the other characters Windows,
 *   Obsidian sync and a zip export cannot hold (`: * ? " < > |`);
 * - control characters and line breaks become spaces, runs of space one;
 * - a leading dot is dropped (`.history` is plumbing), and so are trailing
 *   dots and spaces, which Windows strips on its own;
 * - it is cut at `MAX_STEM` characters, never inside a character;
 * - what is left of nothing (`///`, `..`) is called "Task".
 *
 * A name is **unique against the folder, ignoring case** — a bucket synced to
 * a Mac or through Dropbox cannot hold `Plan.md` beside `plan.md` — and
 * against a folder of the same stem, since `x/task.md` becomes `x/task/`
 * the first time it gets a subtask. A front note's name (`overview.md`,
 * `index.md`, `README.md`) is never a task's: a task called "Overview" would
 * silently become the project's own description. The second is "Name 2".
 *
 * Pure: no React, no storage.
 */

import { FRONT_NOTES } from "../../../../../../mcp/src/lists/grammar.js";

/** The longest name a task title becomes, in characters. */
export const MAX_STEM = 80;
/** What a title with nothing nameable in it is called. */
export const FALLBACK_STEM = "Task";
/** Names never given to a task, lower-cased stems. */
const RESERVED = new Set([
  ...FRONT_NOTES.map((name) => name.replace(/\.md$/i, "").toLowerCase()),
  "privacy",
  // Names Windows will not create, so a zip export or a synced folder would lose the task.
  ...["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])],
]);

/** A name as compared: one Unicode form, one case — `Café` typed on a Mac is `Café` from Windows. */
export const foldName = (name: string): string => name.normalize("NFC").toLowerCase();

/** A title as one line: control characters and runs of space collapsed. */
export function cleanTitle(title: string): string {
  return title
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The stem a title is written under; see the header. */
export function taskStem(title: string): string {
  let stem = cleanTitle(title)
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const chars = Array.from(stem);
  if (chars.length > MAX_STEM) stem = chars.slice(0, MAX_STEM).join("").replace(/[.\s]+$/, "");
  return stem === "" ? FALLBACK_STEM : stem;
}

/** The names directly in `folder` that `paths` show, folded (`foldName`): files, and folders by the paths under them. */
export function namesUnder(folder: string, paths: Iterable<string>): Set<string> {
  const prefix = folder === "" ? "" : `${folder}/`;
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix) || path.length === prefix.length) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(foldName(slash === -1 ? rest : rest.slice(0, slash)));
  }
  return names;
}

function stemTaken(stem: string, taken: ReadonlySet<string>): boolean {
  const folded = foldName(stem);
  return RESERVED.has(folded) || taken.has(folded) || taken.has(`${folded}.md`);
}

/**
 * The first free stem among `stem`, `stem 2`, `stem 3`…: neither `<stem>.md`
 * nor a folder `<stem>` is in `taken` (names as `namesUnder` folds them), and it is not a
 * front note's.
 */
export function uniqueStem(stem: string, taken: ReadonlySet<string>): string {
  if (!stemTaken(stem, taken)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!stemTaken(candidate, taken)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}

/** A free name in a folder for something called `name` (`x.md`, or a folder `x`) being moved in. */
export function uniqueEntryName(name: string, isNote: boolean, taken: ReadonlySet<string>): string {
  const stem = isNote ? name.replace(/\.md$/i, "") : name;
  const free = uniqueStem(stem, taken);
  return isNote ? `${free}${name.slice(stem.length)}` : free;
}
