/**
 * A folder's tags (board 14 of the phone Home artboards, approved by the
 * owner on 2026-09-30): kept on the folder's front note, the note that
 * already carries its description and statuses, as its front matter `tags:`
 * — the only kind of tag this product reads (inline `#tags` are not tags).
 * A folder whose front note is still the placeholder `createFolder` wrote, or
 * that has none, gets an `overview.md` for them, the same way a folder's
 * first status does (`folderPage/model.ts`).
 *
 * Pure: which note, which tags the workspace already uses, and what typing
 * suggests.
 */

import { FRONT_NOTES } from "../../../../mcp/src/lists/grammar.js";

interface TaggedNote {
  readonly path: string;
  readonly tags: readonly string[];
  readonly lede?: string | null;
}

/** The first line `createFolder` writes into a new folder's README. */
const PLACEHOLDER_LEDE = "Folder placeholder.";

/**
 * The note a folder's tags live on, whether it has to be made, and the tags
 * it carries now. Never the top of the workspace, which has no front note.
 */
export function folderTagTarget(
  folder: string,
  notes: readonly TaggedNote[],
  listed?: readonly string[],
): { path: string; creates: boolean; tags: readonly string[] } | null {
  if (folder === "") return null;
  const byPath = new Map(notes.map((note) => [note.path, note]));
  for (const name of FRONT_NOTES) {
    const note = byPath.get(`${folder}/${name}`);
    /*
      Listed in the folder but not yet in this device's copy: its tags are
      not known, and guessing "none" would write over them, or make an
      `overview.md` that pushes a written README aside. Not yet, then.
    */
    if (note === undefined && listed?.includes(`${folder}/${name}`)) return null;
    if (note === undefined) continue;
    const untouched = name === "README.md" && note.tags.length === 0 && (note.lede ?? "").startsWith(PLACEHOLDER_LEDE);
    if (untouched) continue;
    return { path: note.path, creates: false, tags: note.tags };
  }
  return { path: `${folder}/${FRONT_NOTES[0]}`, creates: true, tags: [] };
}

/** Every tag in the workspace with how many notes carry it, busiest first. */
export function workspaceTags(notes: readonly TaggedNote[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of new Set(note.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * A tag as it will be written: trimmed, without a leading `#`, and with
 * spaces, commas and brackets as hyphens, because front matter `tags:` is a
 * list of words and any of those would split one tag into two, or into a
 * list, on the next read. `""` for nothing.
 */
export function cleanTag(typed: string): string {
  return typed
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/[\s,[\]{}]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * What typing suggests: tags the workspace already uses that hold the
 * letters, those starting with them first, never one the folder already has
 * — "so retainer isn't also spelled retainers". `add` is the typed word as a
 * new tag, offered last, and only when no tag is spelled that way already.
 */
export function tagSuggestions(
  typed: string,
  known: readonly { tag: string; count: number }[],
  current: readonly string[],
): { suggestions: { tag: string; count: number }[]; add: string | null } {
  const word = cleanTag(typed);
  const lower = word.toLocaleLowerCase();
  const have = new Set(current.map((tag) => tag.toLocaleLowerCase()));
  const offered = known.filter((one) => !have.has(one.tag.toLocaleLowerCase()));
  if (word === "") return { suggestions: offered, add: null };
  const matching = offered
    .filter((one) => one.tag.toLocaleLowerCase().includes(lower))
    .sort(
      (a, b) =>
        Number(b.tag.toLocaleLowerCase().startsWith(lower)) - Number(a.tag.toLocaleLowerCase().startsWith(lower)) ||
        b.count - a.count ||
        a.tag.localeCompare(b.tag),
    );
  const exists = known.some((one) => one.tag.toLocaleLowerCase() === lower) || have.has(lower);
  return { suggestions: matching, add: exists ? null : word };
}

/** One note whose tags a Tags sheet changes: a picked note, or a picked folder's front note. */
export interface TagTarget {
  path: string;
  creates: boolean;
  tags: readonly string[];
}

/**
 * What tagging several picked rows writes to (board 16's Tags): a note is
 * tagged on itself, a folder on its front note. Anything else — a drawing,
 * an image — has no front matter to carry a tag, and is left out, as is
 * anything whose tags this device does not know yet.
 */
export function bulkTagTargets(
  paths: readonly string[],
  notes: readonly TaggedNote[],
  folders: readonly string[],
  listed: (folder: string) => readonly string[] | undefined = () => undefined,
): TagTarget[] {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const isFolder = new Set(folders);
  const targets: TagTarget[] = [];
  for (const path of paths) {
    if (isFolder.has(path)) {
      const target = folderTagTarget(path, notes, listed(path));
      if (target !== null) targets.push(target);
    } else if (path.endsWith(".md")) {
      // A note this device has not read yet has tags nobody here knows; left out rather than written over.
      const note = byPath.get(path);
      if (note !== undefined) targets.push({ path, creates: false, tags: note.tags });
    }
  }
  return targets;
}

/** The tags every target already carries, which is what the sheet starts with; in the first one's order. */
export function sharedTags(targets: readonly TagTarget[]): string[] {
  const [first, ...rest] = targets;
  if (first === undefined) return [];
  return first.tags.filter((tag) => rest.every((target) => target.tags.includes(tag)));
}

/**
 * One target's tags after the sheet: what it had, less what was taken off
 * the shared ones, plus what was added. A tag only some of them carry was
 * never in the sheet, so it is kept where it was.
 */
export function retagged(before: readonly string[], initial: readonly string[], after: readonly string[]): string[] {
  const removed = initial.filter((tag) => !after.includes(tag));
  const kept = before.filter((tag) => !removed.includes(tag));
  return [...kept, ...after.filter((tag) => !kept.includes(tag))];
}

/**
 * Write the sheet's answer to every target, then say how it went with an
 * Undo that puts each changed note's tags back as they were. The first
 * refusal stops the rest and is the answer; what was already written stays,
 * and is what Undo covers.
 */
export async function retagAll({
  targets,
  after,
  save,
}: {
  targets: readonly TagTarget[];
  after: readonly string[];
  save: (path: string, tags: readonly string[], create: boolean) => Promise<string | null>;
}): Promise<{ problem: string | null; changed: { path: string; from: readonly string[] }[] }> {
  const initial = sharedTags(targets);
  const changed: { path: string; from: readonly string[] }[] = [];
  for (const target of targets) {
    const next = retagged(target.tags, initial, after);
    const same = next.length === target.tags.length && next.every((tag, index) => tag === target.tags[index]);
    if (same) continue;
    const problem = await save(target.path, next, target.creates);
    if (problem !== null) return { problem, changed };
    changed.push({ path: target.path, from: target.tags });
  }
  return { problem: null, changed };
}

/** What a tag target is called in the sheet's title: a folder for its front note, else the note. */
export function tagTargetName(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const folder = path.slice(0, Math.max(slash, 0));
  if ((FRONT_NOTES as readonly string[]).includes(name) && folder !== "") {
    return folder.slice(folder.lastIndexOf("/") + 1);
  }
  return name.replace(/\.md$/, "");
}

/** The paths the console has listed directly in `folder`, or `undefined` before it has listed it. */
export function listedIn(
  listings: Readonly<Record<string, { entries: readonly { path: string }[] } | undefined>>,
  folder: string,
): readonly string[] | undefined {
  return listings[folder]?.entries.map((entry) => entry.path);
}
