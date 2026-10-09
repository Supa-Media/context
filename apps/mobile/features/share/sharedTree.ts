import type { DemoContextTree } from "../console/placeholderData/treeHelpers";
import type { FileEntry, FolderListing } from "../console/files/types";
import { onwardLinks, type SharedNote } from "./share";

/**
 * A shared link's reach as a tree the console's own frame can draw.
 *
 * The share page is the console (Dev2, 2026-10-09: "it should look like the
 * actual editor"), so what a link reaches has to arrive in the shape the
 * console's file browser reads: listings by folder and note bodies by path.
 * This builds that shape from exactly what `readSharedNote` returned and
 * nothing else. Every path in it came from the server, which has already put
 * it through the privacy engine at `team` scope; this module only arranges
 * them, and adds no path the server did not name.
 *
 * Only the note on screen has a body. The others (the entry note while the
 * reader is on a linked one, the notes it links to, what is inside a shared
 * folder) are rows without one, and `isLoaded` is how the share page tells
 * them apart: opening one asks the server for it, the way following a link on
 * the old page did.
 */
export function sharedTree(note: SharedNote, readOnlyReason: string): DemoContextTree {
  const listings: Record<string, FolderListing> = {};
  const notes: Record<string, string> = {};
  const expanded = new Set<string>();

  const listing = (path: string): FolderListing => {
    let found = listings[path];
    if (found === undefined) {
      found = { path, folderDefault: "team", entries: [], truncated: false, manifestUsable: true };
      listings[path] = found;
    }
    return found;
  };

  const add = (path: string, kind: FileEntry["kind"]) => {
    const parts = path.split("/").filter((part) => part !== "");
    let parent = "";
    listing("");
    for (let index = 0; index < parts.length; index++) {
      const here = parts.slice(0, index + 1).join("/");
      const last = index === parts.length - 1;
      const entryKind = last ? kind : "folder";
      const into = listing(parent);
      if (!into.entries.some((entry) => entry.path === here)) {
        into.entries.push(entry(here, parts[index]!, entryKind));
      }
      if (!last) {
        expanded.add(here);
        listing(here);
      }
      parent = here;
    }
  };

  if (note.kind === "folder") {
    add(note.path, "folder");
    expanded.add(note.path);
    for (const inside of note.entries) add(inside.path, inside.kind);
  } else {
    if (note.entryPath !== note.path) add(note.entryPath, "file");
    add(note.path, "file");
    notes[note.path] = note.text ?? "";
    for (const link of onwardLinks(note)) add(link, "file");
  }

  for (const folder of Object.values(listings)) folder.entries.sort(byFolderThenName);

  return {
    listings,
    notes,
    defaultSelection: note.path,
    defaultExpanded: [...expanded],
    readOnlyReason,
  };
}

/**
 * Whether the tree already holds what opening `path` would show.
 *
 * The note on screen, or the shared folder whose listing came back with it. A
 * folder that only appears as an ancestor of a linked note has a listing here,
 * but not its real one, so it is not loaded: that listing holds only the rows
 * the link reaches, and drawing it as the folder would claim the folder holds
 * nothing else.
 */
export function isLoaded(note: SharedNote, path: string): boolean {
  return path === note.path;
}

function entry(path: string, name: string, kind: FileEntry["kind"]): FileEntry {
  return {
    kind,
    path,
    name,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

function byFolderThenName(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}
