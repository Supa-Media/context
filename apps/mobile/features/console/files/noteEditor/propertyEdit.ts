/**
 * Which Properties rows can be changed from the panel, and the change itself.
 *
 * The panel draws what `properties()` reads — a shallow reader that shows a
 * nested map's children as flat rows and a list as an empty value. The write
 * is `setNoteProperty` (`apps/mcp/src/lists/setProperty.js`), the same
 * one-line frontmatter write a folder list uses to change a status: it touches
 * that key's line and nothing else, and refuses rather than guesses when what
 * it wrote would not read back as the value given.
 *
 * So a row is offered for editing only where the two agree about what it is: a
 * top-level `key: value` line (not a nested map's child), whose key the writer
 * accepts, whose value reads as one piece of text (not a list), and which is
 * the last line with that key — the one the reader and the writer both take.
 * Everything else is still shown, read-only, exactly as before.
 */

import { noteProperties, setNoteProperty } from "../../../../../mcp/src/lists.js";
import { properties, type Property } from "../frontmatter";

export interface PropertyRow extends Property {
  /** The panel may change this row in place. */
  editable: boolean;
  /** The value to put in the field: the reader's, without a trailing comment. */
  raw?: string;
}

const NAME = /^[A-Za-z][\w-]*$/;

/**
 * `visibility` is never a property you can set here. `privacy.md` decides who
 * can read a note, and the panel shows that answer in this row rather than the
 * file's line — see `withVisibility`.
 */
const NOT_HERE = new Set(["visibility"]);

/** `properties(frontmatter)`, each row marked with whether it can be edited. */
export function propertyRows(frontmatter: string): PropertyRow[] {
  const rows = properties(frontmatter);
  const read = noteProperties(frontmatter) as Record<string, string | string[]>;
  const topLevel = topLevelKeys(frontmatter);
  // The last row per key, which is the one both the reader and the writer take.
  const last = new Map<string, number>();
  rows.forEach((row, index) => last.set(row.key, index));
  return rows.map((row, index) => {
    const value = read[row.key];
    const editable =
      typeof value === "string" &&
      NAME.test(row.key) &&
      !NOT_HERE.has(row.key) &&
      last.get(row.key) === index &&
      topLevel.lastRowIsTopLevel(row.key);
    return editable ? { ...row, editable, raw: value } : { ...row, editable: false };
  });
}

/**
 * Whether the last line naming a key is a top-level one.
 *
 * `properties()` trims every line, so `team:\n  owner: Bo` shows an `owner`
 * row; the writer only ever changes a top-level `owner:`. A row whose last
 * occurrence is indented would edit a different line than the one on screen.
 */
function topLevelKeys(frontmatter: string) {
  const lastIndented = new Map<string, boolean>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("---")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === "") continue;
    lastIndented.set(key, /^\s/.test(line));
  }
  return { lastRowIsTopLevel: (key: string) => lastIndented.get(key) === false };
}

/**
 * The note with one property set (a string) or removed (`null`), or why not.
 *
 * `adding` refuses a key the note already has, so "Add property" can never
 * quietly overwrite a value that is off screen or further up the card.
 */
export function changeProperty(
  source: string,
  key: string,
  value: string | null,
  adding = false,
): { text: string } | { error: string } {
  const name = key.trim();
  if (name === "") return { error: "Give the property a name." };
  if (!NAME.test(name)) {
    return { error: "A property name starts with a letter and uses letters, numbers, - or _." };
  }
  if (NOT_HERE.has(name)) return { error: "Who can see a note is set with Share, not as a property." };
  if (adding && name in (noteProperties(source) as object)) {
    return { error: `This note already has ${name}. Change it above.` };
  }
  if (value !== null && value.trim() === "") {
    return adding ? { error: "Give it a value." } : { error: "A property needs a value. Remove it instead." };
  }
  const changed = setNoteProperty(source, name, value);
  if ("error" in changed) return { error: sentence(changed.error ?? "it would not read back as written") };
  return { text: changed.text };
}

function sentence(reason: string): string {
  return `That can’t be saved: ${reason}.`;
}
