/**
 * What a scene's workspace steps do to the homepage's tree (`localTree.ts`):
 * find what a script names, make the folders it asks for, and write the one
 * line of a note a status is. Pure, like the tree it changes; the moves and
 * renames themselves are `localTree`'s, through `useLocalFileBrowser`, so the
 * tabs and the open note follow them exactly as they follow a visitor's.
 *
 * A name that is not in the tree is `null`, and the step is skipped: a scene
 * never guesses which note it meant.
 */

import { setNoteProperty } from "../../../mcp/src/lists.js";
import { FRONT_NOTES } from "../../../mcp/src/lists/grammar.js";
import type { DemoContextTree } from "../console/placeholderData/treeHelpers";
import { addFolder, addNote } from "./localTree";

const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A name as people write it either way: `1-projects` and `Projects`, `beta-launch` and `Beta launch`. */
function loose(name: string): string {
  return name
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_ ]+/, "")
    .replace(/[-_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The folder or note a script names: its path exactly, then loosely, in any case and
 * without numbers, by its end alone (`beta-launch`, or `Beta launch`), the shallowest
 * first. `null` when nothing is called that.
 */
export function findPath(
  tree: { listings: Readonly<Record<string, unknown>>; notes: Readonly<Record<string, string>> },
  written: string, want: "folder" | "note" | "any" = "any"): string | null {
  const name = written.trim().replace(/^\/+|\/+$/g, "");
  if (name === "") return null;
  const folders = want === "note" ? [] : Object.keys(tree.listings).filter((path) => path !== "");
  const notes = want === "folder" ? [] : Object.keys(tree.notes);
  const all = [...folders, ...notes];
  const exact = all.find((path) => path === name || path === `${name}.md`);
  if (exact !== undefined) return exact;
  // Each part of what was written against the end of a path: `projects/beta launch`.
  const parts = name.split("/").map(loose);
  const matches = all.filter((path) => {
    const segments = path.split("/").map(loose);
    if (segments.length < parts.length) return false;
    return parts.every((part, index) => segments[segments.length - parts.length + index] === part);
  });
  matches.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return matches[0] ?? null;
}

/**
 * The folder at `path`, made along with any folder above it that is missing.
 * A part that names a folder already there, however it was written, is that
 * folder: `projects/launch` goes inside `1-projects`.
 */
export function ensureFolder(tree: DemoContextTree, path: string): { tree: DemoContextTree; path: string } | null {
  let next = tree;
  let at = "";
  for (const part of path.split("/").filter((one) => one.trim() !== "")) {
    const inside = (next.listings[at]?.entries ?? []).find((entry) => entry.kind === "folder" && loose(entry.name) === loose(part));
    if (inside !== undefined) {
      at = inside.path;
      continue;
    }
    if (next.notes[at === "" ? part : `${at}/${part}`] !== undefined) return null;
    const made = addFolder(next, at, part);
    if (made === null) return null;
    next = made.tree;
    at = made.path;
  }
  return at === "" ? null : { tree: next, path: at };
}

/**
 * Where a status is written: a note's own front matter, or a folder's front
 * note (`overview.md`, `index.md`, `README.md`, the first there), which is
 * made, titled as the folder, when there is none. The folder is then a
 * project, the way anybody makes one.
 */
export function setStatus(tree: DemoContextTree, path: string, status: string): { tree: DemoContextTree; path: string } | null {
  let next = tree;
  let note = next.notes[path] === undefined ? null : path;
  if (note === null) {
    if (next.listings[path] === undefined) return null;
    note = FRONT_NOTES.map((name) => `${path}/${name}`).find((candidate) => next.notes[candidate] !== undefined) ?? null;
    if (note === null) {
      const made = addNote(next, path, "overview", `# ${titleOf(path)}\n`);
      if (made === null) return null;
      next = made.tree;
      note = made.path;
    }
  }
  const written = setNoteProperty(next.notes[note]!, "status", status) as { text: string } | { error: string };
  if ("error" in written) return null;
  return { tree: { ...next, notes: { ...next.notes, [note]: written.text } }, path: note };
}

/** A task in a project folder: a note of its own, named for its words, not started. */
export function addTask(tree: DemoContextTree, folder: string, text: string): { tree: DemoContextTree; path: string } | null {
  if (tree.listings[folder] === undefined) return null;
  const name = text.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60);
  return addNote(tree, folder, name, `---\nstatus: to do\n---\n# ${text.trim()}\n`);
}

/** A folder's name as a title: `beta-launch` is Beta launch. */
function titleOf(path: string): string {
  const words = baseOf(path).replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").trim();
  return words === "" ? baseOf(path) : words.charAt(0).toUpperCase() + words.slice(1);
}

