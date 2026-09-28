import { useRef } from "react";
import type { FileEntry } from "../../files/types";

/**
 * What the region draws while the next note is on its way: the page that is
 * already there.
 *
 * Owner, 2026-09-28: "loading a page first shows a blank page before actually
 * loading … we keep the preview of the currently loaded note until the note
 * we are going to is fully ready to be switched." The selection moves the
 * moment somebody presses a row or a link — the tab, the address and the
 * guard all need it to — but the note's body is a Convex read away, and until
 * it lands there were two ways to draw the gap, both wrong:
 *
 *  - a note no listing names yet (a link, a tab, anything on a phone, which
 *    has no tree) had no entry, so the region drew **nothing**;
 *  - a note its folder page or the tree does name had an entry, so the region
 *    drew **the editor, empty**, with its placeholder, when the previous page
 *    was a folder.
 *
 * So while an open is in flight the region keeps drawing what it drew last,
 * and swaps in one commit when the editor holds the note (`opening` clears in
 * the same batch as `opened`). A failed read clears `opening` too, and then
 * the region moves on to the selection and the notice explaining it, exactly
 * as before.
 */
export function shownEntry({
  target,
  held,
  selectedPath,
  opening,
  editorPath,
}: {
  /** What the selection names, as `entryAt` answers it. */
  target: FileEntry | null;
  /** What was drawn last while nothing was on its way, in this context. */
  held: FileEntry | null;
  selectedPath: string | null;
  opening: string | null;
  editorPath: string | null;
}): FileEntry | null {
  const arriving = opening !== null && opening === selectedPath && editorPath !== selectedPath;
  if (!arriving || held === null || held.path === selectedPath) return target;
  /*
    A held note is only worth keeping while the editor still holds it. Drawn
    against any other editor state it is the empty editor this exists to
    avoid, under the wrong name.
  */
  if (held.kind === "file" && editorPath !== held.path) return target;
  return held;
}

export function useShownEntry({
  target,
  contextId,
  selectedPath,
  opening,
  editorPath,
}: {
  target: FileEntry | null;
  /** The context the browser is on; nothing is held across a switch. */
  contextId: string | null;
  selectedPath: string | null;
  opening: string | null;
  editorPath: string | null;
}): FileEntry | null {
  const last = useRef<{ contextId: string | null; entry: FileEntry | null } | null>(null);
  const held = last.current !== null && last.current.contextId === contextId ? last.current.entry : null;
  const shown = shownEntry({ target, held, selectedPath, opening, editorPath });
  /*
    Remembered during render, like `editorRef`: what is remembered is exactly
    what this render draws, so the next render holds the page that is on the
    glass rather than one an effect caught a commit late.
  */
  last.current = { contextId, entry: shown };
  return shown;
}
