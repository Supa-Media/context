/**
 * The read-only file browser on the landing page.
 *
 * The same components as the real console, driven by literals instead of a
 * bucket — so the marketing page is the product, not a screenshot of it. The
 * tree expands and notes open, because those are honest; **nothing here can
 * act**. `canEdit` is false and every mutating method is a no-op the UI never
 * renders a control for, which is the same rule `useDemoConsoleData` already
 * applies to Revoke: a visitor is never offered a button that would lie.
 *
 * The data is chosen to teach the one thing the visibility UI is trying to
 * teach. `1-projects` defaults to team and `ltn-2026.md` inside it is held
 * back as private, so the landing page shows a folder carrying its default and
 * exactly one file carrying a marker — which is the whole model, visible in
 * four rows.
 */

import { useCallback, useMemo, useReducer, useState } from "react";
import type { FileBrowser } from "./browser";
import { editorReducer, emptyEditor } from "./editor";
import type { FileEntry, FolderListing, OpenNote } from "./types";

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
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

function folder(path: string, visibility: "private" | "team"): FileEntry {
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

function listing(path: string, folderDefault: "private" | "team", entries: FileEntry[]): FolderListing {
  return { path, folderDefault, entries, truncated: false, manifestUsable: true };
}

const DEMO_LISTINGS: Record<string, FolderListing> = {
  "": listing("", "private", [
    folder("0-inbox", "private"),
    folder("1-projects", "team"),
    folder("2-areas", "private"),
    folder("3-resources", "private"),
    folder("4-archive", "private"),
    file("index.md"),
    file("privacy.md", { readOnly: true }),
  ]),
  "1-projects": listing("1-projects", "team", [
    file("1-projects/context-lc.md", { visibility: "team", inherited: "team" }),
    file("1-projects/ltn-2026.md", {
      visibility: "private",
      inherited: "team",
      exception: true,
    }),
  ]),
  "2-areas": listing("2-areas", "private", [
    folder("2-areas/communications", "private"),
    folder("2-areas/public-worship", "private"),
  ]),
};

/** The mockup's note, verbatim. */
const DEMO_NOTES: Record<string, string> = {
  "1-projects/context-lc.md": [
    "---",
    "updated: 2026-08-26",
    "status: active",
    "---",
    "",
    "# Context.LC — build decisions",
    "",
    "Tenancy is bucket-level, never prefix-level. No key",
    "namespacing inside a customer bucket, so an existing",
    "brain connects with zero migration and Obsidian",
    "Remotely Save keeps working.",
    "",
    "A shared context is just a workspace with more than",
    "one member — so a storage binding hangs off a",
    "workspaceId, never a userId.",
    "",
  ].join("\n"),
  "1-projects/ltn-2026.md": [
    "---",
    "updated: 2026-08-19",
    "visibility: team",
    "---",
    "",
    "# LTN 2026",
    "",
    "Held back from the folder's team default. The frontmatter",
    "above says `team` and is ignored — privacy.md is what",
    "decides, and it lists this note as an exception.",
    "",
  ].join("\n"),
  "index.md": ["# Context", "", "Plain markdown files you own.", ""].join("\n"),
  "privacy.md": [
    "---",
    "role: privacy-manifest",
    "---",
    "",
    "# Access map",
    "",
    "This file decides what a connected AI client is allowed to see.",
    "",
    "<!-- BEGIN BRAIN PRIVACY RULES -->",
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    "  0-inbox: private",
    "  1-projects: team",
    "  2-areas: private",
    "  3-resources: private",
    "  4-archive: private",
    "",
    "note_overrides:",
    "  1-projects/ltn-2026.md: private",
    "```",
    "",
    "<!-- END BRAIN PRIVACY RULES -->",
    "",
  ].join("\n"),
};

const DEMO_SELECTED = "1-projects/context-lc.md";

function demoNote(path: string): OpenNote | null {
  const text = DEMO_NOTES[path];
  if (text === undefined) return null;
  const entry =
    DEMO_LISTINGS[path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""]?.entries.find(
      (candidate) => candidate.path === path,
    ) ?? null;
  return {
    path,
    text,
    etag: "demo",
    visibility: entry?.visibility ?? "private",
    inherited: entry?.inherited ?? "private",
    exception: entry?.exception ?? false,
    // `readOnly` means "this *file* cannot be edited by anyone" — it is only
    // ever `privacy.md`, which is generated. That the demo cannot edit
    // anything is a different fact, carried by `canEdit`, and conflating the
    // two put the manifest's explainer on top of every note here.
    readOnly: entry?.readOnly ?? false,
  };
}

const noop = () => {};

export function useDemoFileBrowser(): FileBrowser {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["1-projects"]));
  const [selectedPath, setSelectedPath] = useState<string | null>(DEMO_SELECTED);
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor, () =>
    editorReducer(emptyEditor, { type: "opened", note: demoNote(DEMO_SELECTED)! }),
  );

  const select = useCallback((path: string) => {
    setSelectedPath(path);
    const note = demoNote(path);
    // A folder has no body, so the pane shows its summary instead of an editor.
    if (note === null) dispatch({ type: "closed" });
    else dispatch({ type: "opened", note });
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      canEdit: false,
      readOnlyReason: "This is a demo. Sign in to edit your own context.",
      loading: false,
      busy: false,
      listings: DEMO_LISTINGS,
      expanded,
      toggleFolder,
      selectedPath,
      select,
      editor,
      setDraft: noop,
      save: noop,
      useTheirs: noop,
      keepMine: noop,
      discard: noop,
      notice: null,
      dismissNotice: noop,
      clipboard: null,
      copy: noop,
      cut: noop,
      paste: noop,
      createNote: noop,
      createFolder: noop,
      rename: noop,
      move: noop,
      duplicate: noop,
      archive: noop,
      destroy: noop,
      setVisibility: noop,
    }),
    [editor, expanded, select, selectedPath, toggleFolder],
  );
}
