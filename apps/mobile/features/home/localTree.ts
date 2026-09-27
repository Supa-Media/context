import type { FileEntry } from "../console/files/types";
import type { DemoContextTree } from "../console/placeholderData/treeHelpers";

/**
 * The homepage's workspace as a visitor changes it: the same tree, edited in
 * memory and nowhere else.
 *
 * The homepage is there to show how the app is used, so a visitor can write in
 * a page, add pages and folders, rename and delete them. None of it leaves the
 * tab: there is no bucket behind this tree and nothing here calls one. A
 * reload is the site again. Pure, so every change is a function of the tree
 * before it and the tests read it without a screen.
 */

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function fileEntry(path: string, kind: FileEntry["kind"]): FileEntry {
  return {
    kind,
    path,
    name: baseName(path),
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

/** A name nobody in `folder` has yet: `name`, else `name 2`, `name 3`… */
export function freeName(tree: DemoContextTree, folder: string, name: string): string {
  const taken = new Set((tree.listings[folder]?.entries ?? []).map((entry) => entry.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : name.length;
  for (let n = 2; ; n += 1) {
    const candidate = `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** A folder or note name as typed: no slashes, never empty. */
function cleanName(name: string): string {
  return name.replace(/[/\\]/g, "-").trim();
}

function withEntry(tree: DemoContextTree, entry: FileEntry): DemoContextTree {
  const folder = parentOf(entry.path);
  const listing = tree.listings[folder];
  if (listing === undefined) return tree;
  return {
    ...tree,
    listings: { ...tree.listings, [folder]: { ...listing, entries: [...listing.entries, entry] } },
  };
}

/** A new note in `folder`, empty unless `text` says otherwise. Answers with its path. */
export function addNote(
  tree: DemoContextTree,
  folder: string,
  name: string,
  text = "",
): { tree: DemoContextTree; path: string } | null {
  const clean = cleanName(name.replace(/\.md$/i, ""));
  if (clean === "" || tree.listings[folder] === undefined) return null;
  const path = join(folder, freeName(tree, folder, `${clean}.md`));
  const next = withEntry(tree, fileEntry(path, "file"));
  return { tree: { ...next, notes: { ...next.notes, [path]: text } }, path };
}

/** A new, empty folder in `folder`. Answers with its path. */
export function addFolder(
  tree: DemoContextTree,
  folder: string,
  name: string,
): { tree: DemoContextTree; path: string } | null {
  const clean = cleanName(name);
  if (clean === "" || tree.listings[folder] === undefined) return null;
  const path = join(folder, freeName(tree, folder, clean));
  const next = withEntry(tree, fileEntry(path, "folder"));
  return {
    tree: {
      ...next,
      listings: {
        ...next.listings,
        [path]: { path, folderDefault: "team", entries: [], truncated: false, manifestUsable: true },
      },
    },
    path,
  };
}

/** Change one note's words. A path that is not a note changes nothing. */
export function editNote(tree: DemoContextTree, path: string, text: string): DemoContextTree {
  if (tree.notes[path] === undefined || tree.notes[path] === text) return tree;
  return { ...tree, notes: { ...tree.notes, [path]: text } };
}

/** Every path at or under `path`, rewritten by `rewrite`; the rest untouched. */
function remap(tree: DemoContextTree, path: string, rewrite: (old: string) => string | null): DemoContextTree {
  const inside = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  const listings: DemoContextTree["listings"] = {};
  for (const [folder, listing] of Object.entries(tree.listings)) {
    const at = inside(folder) ? rewrite(folder) : folder;
    if (at === null) continue;
    const entries: FileEntry[] = [];
    for (const entry of listing.entries) {
      if (!inside(entry.path)) {
        entries.push(entry);
        continue;
      }
      const moved = rewrite(entry.path);
      if (moved !== null) entries.push({ ...entry, path: moved, name: baseName(moved) });
    }
    listings[at] = { ...listing, path: at, entries };
  }
  const notes: Record<string, string> = {};
  for (const [note, text] of Object.entries(tree.notes)) {
    const at = inside(note) ? rewrite(note) : note;
    if (at !== null) notes[at] = text;
  }
  return { ...tree, listings, notes };
}

/** Delete a note, or a folder and everything in it. */
export function removePath(tree: DemoContextTree, path: string): DemoContextTree {
  if (path === "") return tree;
  return remap(tree, path, () => null);
}

/** Rename in place. A note keeps its `.md`. Answers with the new path. */
export function renamePath(
  tree: DemoContextTree,
  path: string,
  name: string,
): { tree: DemoContextTree; path: string } | null {
  const isNote = tree.notes[path] !== undefined;
  const clean = cleanName(isNote ? name.replace(/\.md$/i, "") : name);
  if (clean === "" || path === "") return null;
  const wanted = isNote ? `${clean}.md` : clean;
  if (wanted === baseName(path)) return { tree, path };
  const folder = parentOf(path);
  const target = join(folder, freeName(tree, folder, wanted));
  return { tree: remap(tree, path, (old) => target + old.slice(path.length)), path: target };
}

/** Move into another folder, under a free name there. Answers with the new path. */
export function movePath(
  tree: DemoContextTree,
  path: string,
  destination: string,
): { tree: DemoContextTree; path: string } | null {
  if (path === "" || destination === path || destination.startsWith(`${path}/`)) return null;
  if (tree.listings[destination] === undefined || parentOf(path) === destination) return null;
  const target = join(destination, freeName(tree, destination, baseName(path)));
  const moved = remap(tree, path, (old) => target + old.slice(path.length));
  // `remap` rewrote the entry where it stood; it now belongs to the destination.
  const from = moved.listings[parentOf(path)]!;
  const entry = from.entries.find((candidate) => candidate.path === target)!;
  const into = moved.listings[destination]!;
  return {
    tree: {
      ...moved,
      listings: {
        ...moved.listings,
        [parentOf(path)]: { ...from, entries: from.entries.filter((candidate) => candidate !== entry) },
        [destination]: { ...into, entries: [...into.entries, entry] },
      },
    },
    path: target,
  };
}

/** A copy of a note or a folder, whole, in `destination` under a free name. Answers with its path. */
export function copyPath(
  tree: DemoContextTree,
  path: string,
  destination: string,
): { tree: DemoContextTree; path: string } | null {
  const isNote = tree.notes[path] !== undefined;
  if (path === "" || tree.listings[destination] === undefined) return null;
  if (!isNote && tree.listings[path] === undefined) return null;
  if (destination === path || destination.startsWith(`${path}/`)) return null;
  const target = join(destination, freeName(tree, destination, baseName(path)));
  const moved = (old: string) => target + old.slice(path.length);
  const inside = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  let next = withEntry(tree, fileEntry(target, isNote ? "file" : "folder"));
  const listings = { ...next.listings };
  for (const [folder, listing] of Object.entries(tree.listings)) {
    if (!inside(folder)) continue;
    listings[moved(folder)] = {
      ...listing,
      path: moved(folder),
      entries: listing.entries.map((entry) => ({ ...entry, path: moved(entry.path) })),
    };
  }
  const notes = { ...next.notes };
  for (const [note, text] of Object.entries(tree.notes)) if (inside(note)) notes[moved(note)] = text;
  next = { ...next, listings, notes };
  return { tree: next, path: target };
}

/**
 * Where `path` is after `from` became `to` (`null` when it was deleted): moved
 * with it when it was at or under `from`, untouched otherwise. What keeps the
 * open note, its tab and its page address with a note that was renamed.
 */
export function followPath(path: string, from: string, to: string | null): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) return path;
  return to === null ? null : to + path.slice(from.length);
}

/** Every note at or under `path`: what a tab strip has to hear about a folder. */
export function notesUnder(tree: DemoContextTree, path: string): string[] {
  return Object.keys(tree.notes).filter((note) => note === path || note.startsWith(`${path}/`));
}
