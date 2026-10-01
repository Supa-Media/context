/**
 * The editor lent to a folder page's side peek (`BesideEditing`).
 *
 * Part of `useFileBrowser`, called straight after `useOpenNote`. A folder page
 * holds no note in the editor — selecting a folder closes it — so the peek
 * puts the peeked note there with `openNote`, the same read, restore, draft,
 * autosave and conflict handling a note opened from the tree gets, and the
 * console's collaboration room follows `editor.path` as it always has. The
 * selection, the address and the tab strip stay on the folder: `beside` says
 * which note is only lent, so the strip does not open a tab for it.
 *
 * `select` and `deselect` are wrapped so that any navigation ends the loan: a
 * note selected while it is beside (Expand) simply stays open, and becomes
 * the selection like any other.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { guardLeaving } from "../editor";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OpenNote } from "../types";
import type { OpenNoteValues } from "./useOpenNote";

type BesideDeps =
  & Pick<FileActionsValues, "workspaceId">
  & Pick<BrowserStateValues, "autosave" | "dispatch" | "editorRef" | "openRun" | "selectedPathRef" | "setNotice" | "setOpening">
  & OpenNoteValues;

export function useBesideNote(deps: BesideDeps) {
  const { autosave, dispatch, editorRef, openNote, openRun, select: selectNote, deselect: deselectNote, selectedPathRef, setNotice, setOpening, workspaceId } = deps;
  const [beside, setBeside] = useState<string | null>(null);
  const besideRef = useRef<string | null>(null);
  const lend = useCallback((path: string | null) => {
    besideRef.current = path;
    setBeside(path);
  }, []);

  // A loan belongs to one context: switching ends it with everything else the browser resets.
  useEffect(() => lend(null), [workspaceId, lend]);

  const openBeside = useCallback(
    (path: string): boolean => {
      if (workspaceId === null || !path.endsWith(".md")) return false;
      if (selectedPathRef.current === path) return true;
      // Leaving whatever the editor holds is leaving a note: written first, and asked.
      autosave.flush();
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return false;
      }
      lend(path);
      if (editorRef.current.path !== path) void openNote(path);
      return true;
    },
    [autosave, editorRef, lend, openNote, selectedPathRef, setNotice, workspaceId],
  );

  const closeBeside = useCallback(
    (path: string): boolean => {
      // Something else holds the editor now — another peek, or a note selected meanwhile.
      if (besideRef.current !== path) return true;
      lend(null);
      if (selectedPathRef.current === path) return true;
      autosave.flush();
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return false;
      }
      // A read still on its way for it must not open it again after this.
      openRun.current += 1;
      setOpening(null);
      if (editorRef.current.path === path) dispatch({ type: "closed" });
      return true;
    },
    [autosave, dispatch, editorRef, lend, openRun, selectedPathRef, setNotice, setOpening],
  );

  const select = useCallback(
    (path: string, written?: OpenNote): boolean => {
      const moved = selectNote(path, written);
      if (moved) lend(null);
      return moved;
    },
    [selectNote, lend],
  );
  const deselect = useCallback((): boolean => {
    const moved = deselectNote();
    if (moved) lend(null);
    return moved;
  }, [deselectNote, lend]);

  return { beside, openBeside, closeBeside, select, deselect };
}

export type BesideNoteValues = ReturnType<typeof useBesideNote>;
