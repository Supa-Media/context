import { useEffect, useRef, useState } from "react";
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
  waiting = false,
}: {
  /** What the selection names, as `entryAt` answers it. */
  target: FileEntry | null;
  /**
   * What was drawn last while nothing was on its way, in this context: `null`
   * is the page with nothing selected (a phone's Home), and `undefined` is
   * nothing drawn yet, which holds nothing.
   */
  held: FileEntry | null | undefined;
  selectedPath: string | null;
  opening: string | null;
  editorPath: string | null;
  /**
   * The selection is a page whose reads have not all landed yet — a folder
   * page without its front note, notes and words (`folderPageReady`). Held
   * like a note on its way, so it arrives whole rather than in three steps.
   */
  waiting?: boolean;
}): FileEntry | null {
  const arriving = waiting || (opening !== null && opening === selectedPath && editorPath !== selectedPath);
  if (!arriving || held === undefined || selectedPath === null) return target;
  // Home stays while the note or folder opened from it is read (owner, 2026-10-16).
  if (held === null) return null;
  if (held.path === selectedPath) return target;
  /*
    A held note is only worth keeping while the editor still holds it. Drawn
    against any other editor state it is the empty editor this exists to
    avoid, under the wrong name.
  */
  if (held.kind === "file" && editorPath !== held.path) return target;
  return held;
}

/** How long a folder page may keep the last page on screen while its reads land: past it, it draws what it has. */
export const PAGE_WAIT_MS = 1200;

export interface ShownEntry {
  /** What the region draws. */
  readonly entry: FileEntry | null;
  /** The page drawn is the last one, kept while `selectedPath` is read. */
  readonly holding: boolean;
}

export function useShownEntry({
  target,
  contextId,
  selectedPath,
  opening,
  editorPath,
  waiting = false,
}: {
  target: FileEntry | null;
  /** The context the browser is on; nothing is held across a switch. */
  contextId: string | null;
  selectedPath: string | null;
  opening: string | null;
  editorPath: string | null;
  /** See `shownEntry`. Given up on after `PAGE_WAIT_MS`, so a slow read never strands the last page. */
  waiting?: boolean;
}): ShownEntry {
  const last = useRef<{ contextId: string | null; entry: FileEntry | null } | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const waitingNow = waiting && selectedPath !== null && gaveUp !== selectedPath;
  useEffect(() => {
    if (!waitingNow || selectedPath === null) return;
    const timer = setTimeout(() => setGaveUp(selectedPath), PAGE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitingNow, selectedPath]);
  const held = last.current !== null && last.current.contextId === contextId ? last.current.entry : undefined;
  const shown = shownEntry({ target, held, selectedPath, opening, editorPath, waiting: waitingNow });
  /*
    Remembered during render, like `editorRef`: what is remembered is exactly
    what this render draws, so the next render holds the page that is on the
    glass rather than one an effect caught a commit late.
  */
  last.current = { contextId, entry: shown };
  const arriving = waitingNow || (opening !== null && opening === selectedPath && editorPath !== selectedPath);
  const holding = arriving && held !== undefined && selectedPath !== null && (shown === null || shown.path !== selectedPath);
  return { entry: shown, holding };
}
