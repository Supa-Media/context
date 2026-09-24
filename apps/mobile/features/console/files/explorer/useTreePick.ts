import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import type { FileBrowser } from "../browser";
import { pick, topmost, visiblePick, NO_PICK, type PickGesture, type TreePick } from "../selection";
import type { TreeRow } from "../tree";

/**
 * Picking several rows with ⌘/ctrl-click and shift-click, over the tree as
 * drawn. Called from `useExplorer` at the point these hooks always ran.
 */
export function useTreePick({
  treeRows,
  picked,
  setPicked,
  files,
  overlayOpen,
}: {
  treeRows: TreeRow[];
  picked: TreePick;
  setPicked: Dispatch<SetStateAction<TreePick>>;
  files: FileBrowser;
  overlayOpen: boolean;
}) {
  /* ---------------------------------------------------------------------- */
  /*                         picking several rows                             */
  /* ---------------------------------------------------------------------- */

  /** The rows a range is measured over: the tree as drawn, top to bottom. */
  const order = useMemo(
    () =>
      treeRows
        .filter((row) => row.kind === "file" || row.kind === "folder")
        .map((row) => row.path),
    [treeRows],
  );

  /*
    A collapsed folder takes what was picked inside it out of the pick — see
    `visiblePick`. Written back rather than only filtered on read, because the
    console's keyboard handler reads the same state and must not trash a row
    this tree is no longer drawing. `visiblePick` hands back the same object
    when nothing changed, which is what keeps this from looping.
  */
  useEffect(() => {
    setPicked((current) => visiblePick(current, order));
  }, [order, setPicked]);

  /*
    Opening something else ends the pick. The open note is what the tree
    draws selected when nothing is picked, so this is the tree going back to
    showing the one row a keystroke will act on — whichever way the note was
    opened, including from the palette or a link, where no row was clicked.
  */
  useEffect(() => {
    setPicked(NO_PICK);
  }, [files.selectedPath, setPicked]);

  const shown = visiblePick(picked, order);

  /** One row is drawn selected, or the picked rows are — never both. */
  const rows = useMemo(
    () =>
      shown.paths.size === 0
        ? treeRows
        : treeRows.map((row) =>
            row.selected === shown.paths.has(row.path)
              ? row
              : { ...row, selected: shown.paths.has(row.path) },
          ),
    [shown, treeRows],
  );

  /** The picked rows, outermost only, in tree order — what a batch acts on. */
  const pickedRows = useMemo(() => {
    const byPath = new Map(rows.map((row) => [row.path, row]));
    return topmost(shown.paths, order).flatMap((path) => {
      const row = byPath.get(path);
      return row === undefined ? [] : [row];
    });
  }, [order, rows, shown]);

  /*
    Escape puts a pick down, the way it does in every file manager. Listened
    for only while there is a pick and nothing modal is up — Escape on an open
    menu or dialog is that overlay's, and it should close the menu rather
    than also drop the rows the menu was about. Never consumed: whatever else
    Escape means where focus is, it still means.
  */
  const picking = shown.paths.size > 0;
  useEffect(() => {
    if (!picking || overlayOpen || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicked(NO_PICK);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlayOpen, picking, setPicked]);

  const onPick = useCallback(
    (path: string, gesture: PickGesture) =>
      setPicked((current) =>
        pick(visiblePick(current, order), gesture, path, order, files.selectedPath),
      ),
    [files.selectedPath, order, setPicked],
  );

  return { shown, rows, pickedRows, onPick };
}
