/**
 * What the person has open in the console, as Tex sees it: the open note, the other tabs and a selection.
 *
 * Sent as `seen` on the `/tex/app-chat` send. The gateway checks it (`validSeen` in
 * `packages/tex/gateway/agent/screen.js`) and reads only the paths, so a note id here is the
 * path's tail: the console has no note ids. Nothing here is shown in the UI.
 */

import { useCallback, useEffect, useRef } from "react";

/** A note as the route names it. `workspace` is "@slug"; `path` is relative and ends in `.md`. */
export interface SeenNote {
  workspace: string;
  noteId: string;
  path: string;
}

/** The screen a send carries. Every part is optional; a send with none sends none. */
export interface SeenBody {
  note?: SeenNote;
  tabs?: SeenNote[];
  selection?: string;
}

/** The most other tabs a send carries. */
const MAX_TABS = 8;
/** The most of a selection a send carries: longer is dropped, not cut. */
const MAX_SELECTION = 2000;
/** The most of a path the id keeps: its last characters. */
const MAX_ID = 128;

function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

function noteOf(workspace: string, path: string): SeenNote {
  return { workspace, noteId: path.slice(-MAX_ID), path };
}

/**
 * The screen as a send carries it, or `null` when nothing remains.
 *
 * - The open note is the editor's path when it is a `.md` and there is a slug.
 * - Tabs are the other `.md` tabs, never the editor's own, the first eight.
 * - The selection is trimmed and kept only when it is 1 to 2000 characters.
 */
export function seenFrom(input: {
  slug: string | null;
  editorPath: string | null;
  tabPaths: readonly string[];
  selection: string | null;
}): SeenBody | null {
  const slug = input.slug?.trim() ?? "";
  if (slug === "") return null;
  const workspace = `@${slug}`;
  const editorPath = input.editorPath !== null && isMarkdown(input.editorPath) ? input.editorPath : null;
  const tabs = input.tabPaths
    .filter((path) => isMarkdown(path) && path !== input.editorPath)
    .slice(0, MAX_TABS)
    .map((path) => noteOf(workspace, path));
  const selection = input.selection?.trim() ?? "";
  const keptSelection = selection.length >= 1 && selection.length <= MAX_SELECTION ? selection : null;

  const seen: SeenBody = {
    ...(editorPath !== null ? { note: noteOf(workspace, editorPath) } : {}),
    ...(tabs.length > 0 ? { tabs } : {}),
    ...(keptSelection !== null ? { selection: keptSelection } : {}),
  };
  return Object.keys(seen).length > 0 ? seen : null;
}

/** The editor's element that a node sits in, or false. */
function inEditor(node: Node | null): boolean {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element !== null && element.closest(".cm-editor") !== null;
}

/**
 * The text last highlighted in the note, read at send time.
 *
 * A selection inside the editor is remembered; collapsing it inside the editor clears it. A selection
 * anywhere else (clicking into the chat box, say) leaves the last one standing. Web only: on other
 * platforms the getter returns `null`. Opening another note (`notePath`) forgets it.
 */
export function useEditorSelection(notePath: string | null): () => string | null {
  const last = useRef<string | null>(null);

  // A highlight belongs to the note it was made in: opening another note forgets it.
  useEffect(() => {
    last.current = null;
  }, [notePath]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      const selection = document.getSelection();
      if (selection === null || !inEditor(selection.anchorNode)) return;
      if (selection.isCollapsed) {
        last.current = null;
        return;
      }
      last.current = selection.toString();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  return useCallback(() => last.current, []);
}
