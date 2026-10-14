/**
 * The chips under a note's name, as data: which of the common properties the
 * note has, what each one reads as, and the write that changes one.
 *
 * **"I like the chips"** (owner, 2026-10-14, picking board B of
 * `property-dropdown`): every note, a new one with no front matter included,
 * offers its common properties as chips under its name. A set one is a solid
 * chip that reads as its value ("in progress", "High", "Fri"); an unset one is
 * a faint outline that says what it would be ("Status", "Owner"), and one press
 * adds it and opens its list. Everything else is under More.
 *
 * Pure — no React, no storage. The words are the folder page's own
 * (`folderPage/taskProps.ts`, `tasks/taskWords.ts`), so a value reads the same
 * under a note's name as on its row in a project list.
 */

import { noteProperties, setNoteProperty } from "../../../../../../mcp/src/lists.js";
import type { PropertyValue } from "../../listBlock/model";
import { splitNote } from "../../frontmatter";
import { dueOf, dueWord, estimateOf, ownersOf, priorityOf, priorityWord, tagsOf } from "../../folderPage/taskProps";

/**
 * Whether a note gets chips at all: not a website page, whose front matter is
 * the page's settings, and not `privacy.md`, which is rules. A folder's
 * `about.md` does: its status is the folder's — a project's — own.
 */
export function chipsFit(path: string): boolean {
  if (path === "website" || path.startsWith("website/")) return false;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name !== "privacy.md" && !/\.(html|css)\.md$/.test(name);
}

/** The properties a chip stands for, in the order they are drawn. */
export const CHIP_KEYS = ["status", "owner", "priority", "due", "estimate", "tags"] as const;
export type ChipKey = (typeof CHIP_KEYS)[number];

/** Drawn as their own faint chip when unset; the rest wait under More. */
export const COMMON_CHIPS: readonly ChipKey[] = ["status", "owner", "priority", "due"];

/** What an unset chip says: the property, in plain words. */
export const CHIP_NAMES: Readonly<Record<ChipKey, string>> = {
  status: "Status",
  owner: "Owner",
  priority: "Priority",
  due: "Due date",
  estimate: "Estimate",
  tags: "Tags",
};

type Properties = Readonly<Record<string, PropertyValue>>;

export interface SetChip {
  readonly key: ChipKey;
  /** What the solid chip reads. */
  readonly label: string;
  /** The value as written, for a status's tone and a menu's tick. */
  readonly raw: string;
}

export interface NoteChips {
  /** Each property the note has a value for, as the chip that shows it. */
  readonly set: readonly SetChip[];
  /** The common ones it does not have yet, drawn faint. */
  readonly unset: readonly ChipKey[];
  /** The rest it does not have, offered under More. */
  readonly more: readonly ChipKey[];
}

/** The chips a note's text draws, read at `now` (a due day reads "Today" today). */
export function noteChips(text: string, now: number): NoteChips {
  const properties = noteProperties(text) as Properties;
  const set: SetChip[] = [];
  const missing: ChipKey[] = [];
  for (const key of CHIP_KEYS) {
    const chip = chipFor(key, properties, now);
    if (chip === null) missing.push(key);
    else set.push(chip);
  }
  return {
    set,
    unset: missing.filter((key) => COMMON_CHIPS.includes(key)),
    more: missing.filter((key) => !COMMON_CHIPS.includes(key)),
  };
}

function first(value: PropertyValue | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * One property as its chip, or null when the note has no value for it that a
 * chip can show — a `priority: soon` is no priority, as it is on a list row,
 * and its line is still in the file for the Properties card to show.
 */
function chipFor(key: ChipKey, properties: Properties, now: number): SetChip | null {
  switch (key) {
    case "status": {
      const status = first(properties.status);
      return status === "" ? null : { key, label: status, raw: status };
    }
    case "owner": {
      const owners = ownersOf(properties);
      if (owners.length === 0) return null;
      const label = owners.length === 1 ? owners[0]! : `${owners[0]} +${owners.length - 1}`;
      return { key, label, raw: owners[0]! };
    }
    case "priority": {
      const priority = priorityOf(properties);
      return priority === null ? null : { key, label: priorityWord(priority), raw: `p${priority}` };
    }
    case "due": {
      const due = dueOf(properties);
      return due === null ? null : { key, label: `Due ${dueWord(due, now)}`, raw: first(properties.due) };
    }
    case "estimate": {
      const estimate = estimateOf(properties);
      return estimate === null ? null : { key, label: `Size ${estimate}`, raw: estimate };
    }
    case "tags": {
      const tags = tagsOf(properties);
      return tags.length === 0 ? null : { key, label: tags.map((tag) => `#${tag}`).join(" "), raw: tags.join(", ") };
    }
  }
}

/**
 * Whether a note is still new: nothing written under its name.
 *
 * The faint chips show on a new note without anybody pointing at it — that is
 * the note the owner asked about, the one with no front matter "yet" — and
 * otherwise wait for the pointer. A first `# heading` is the name, so it does
 * not count as writing.
 */
export function isFresh(text: string): boolean {
  const { body } = splitNote(text);
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return true;
  return lines.length === 1 && /^\s*#\s/.test(lines[0]!);
}

/**
 * The note with one chip's property set, or `null` to take it off; the text
 * to save, or why not in a sentence.
 *
 * The Properties card's write (`setNoteProperty`): the property's one line and
 * nothing else changes, a note with no front matter gets a block, and a value
 * that would not read back as given is refused rather than guessed at. Tags
 * are a list; an owner list keeps its others.
 */
export function chipWrite(
  text: string,
  key: ChipKey,
  value: string | readonly string[] | null,
): { text: string } | { error: string } {
  const written = Array.isArray(value) && value.length === 0 ? null : value;
  const changed = setNoteProperty(text, key, written === null ? null : Array.isArray(written) ? [...written] : written) as
    | { text: string }
    | { error?: string };
  if ("text" in changed) return { text: changed.text };
  return { error: `That can’t be saved: ${changed.error ?? "it would not read back as written"}.` };
}

/**
 * The owner line after choosing `owner`. A note with one owner (or none) gets
 * this one instead, which is what pressing a chip that reads one name and
 * picking another means; a note that already names several keeps them and
 * gains this one, never twice, so a pick never quietly drops a co-owner.
 */
export function withOwner(text: string, owner: string): string | string[] {
  const owners = ownersOf(noteProperties(text) as Properties);
  if (owners.length <= 1) return owner;
  if (owners.some((each) => each.toLowerCase() === owner.toLowerCase())) return owners;
  return [...owners, owner];
}

/** The tags after adding `tag`, never twice. */
export function withTag(text: string, tag: string): string[] {
  const tags = tagsOf(noteProperties(text) as Properties);
  return tags.some((each) => each.toLowerCase() === tag.toLowerCase()) ? tags : [...tags, tag];
}
