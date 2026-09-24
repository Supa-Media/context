/**
 * The file editor's logic, without a renderer.
 *
 * Everything here is a pure module by design (see `jest.config.js`): the
 * console's tests run in plain node, so the rules worth pinning — what a
 * conflict does to an unsaved draft, which files get a visibility marker, what
 * a paste turns into — live outside the components rather than inside them.
 *
 * The one that matters most is the marker rule. "Mark only what differs from
 * the folder default" is a data property, not a style, and it is the thing
 * somebody will eventually be tempted to "fix" by labelling everything.
 *
 * This module carries the shared fixtures for every file in this folder; it
 * has no tests of its own.
 */

import { editorReducer, emptyEditor, type EditorState } from "../../features/console/files/editor";
import type { FileEntry, FolderListing, OpenNote } from "../../features/console/files/types";

export function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

export function folder(path: string, visibility: "private" | "team" = "private"): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

export function listing(path: string, entries: FileEntry[]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries,
    truncated: false,
    manifestUsable: true,
  };
}

export const NOTE: OpenNote = {
  path: "1-projects/a.md",
  text: "# A\n",
  etag: "e1",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

export function opened(): EditorState {
  return editorReducer(emptyEditor, { type: "opened", note: NOTE });
}

export function folderEntry(path: string): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

export function fileEntry(path: string): FileEntry {
  return { ...folderEntry(path), kind: "file" };
}
