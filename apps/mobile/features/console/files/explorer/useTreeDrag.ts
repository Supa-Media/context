import { useEffect, useMemo, useState } from "react";
import type { FileBrowser } from "../browser";
import { canDrop as verdictFor, type DragModifier, type DragSource } from "../dnd";
import type { TreeDragHandlers } from "../FileTree";
import { parentPath } from "../paths";
import { NO_PICK, type TreePick } from "../selection";
import { findEntry, type TreeRow } from "../tree";
import { dropZoneAt, planTreeDrop, type DropZone } from "../treeDrop";

/** Where a drop would land, as the tree draws it: a line above or below a row, or a wash on it. */
export interface TreeDropAt {
  path: string;
  zone: DropZone;
}

/**
 * Dragging rows in the sidebar tree: what is being carried, where it would
 * land, and what dropping it does. Out of `useExplorer` so that hook stays
 * one screen of state; the rules are `dnd.ts` (into a folder) and
 * `treeDrop.ts` (above, below or into a row, and what a folder's place among
 * its siblings becomes).
 *
 * Reset when the context changes, for the reason `useExplorer` records at
 * length: a drag still held from the old tree, dropped into the new one, is a
 * move nobody asked for.
 */
export function useTreeDrag({
  files,
  descending,
  contextLabel,
  pickedRows,
  shown,
  setPicked,
  refuse,
}: {
  files: FileBrowser;
  descending: boolean;
  contextLabel: string;
  pickedRows: readonly TreeRow[];
  shown: { paths: ReadonlySet<string> };
  setPicked: (pick: TreePick) => void;
  /** Say why a drop was refused, in the tree's refusal line. */
  refuse: (reason: string) => void;
}): { dragHandlers: TreeDragHandlers | undefined; dropTarget: TreeDropAt | null } {
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<TreeDropAt | null>(null);

  useEffect(() => {
    setDrag(null);
    setDropTarget(null);
  }, [contextLabel]);

  const dragHandlers = useMemo<TreeDragHandlers | undefined>(() => {
    if (!files.canEdit) return undefined;

    /** The zone under the pointer, and what dropping there would do. */
    const planAt = (source: DragSource, path: string, modifiers: readonly DragModifier[], at: number | undefined) => {
      const copying = modifiers.includes("copy");
      // A copy is always into a folder: there is no copy to a place.
      const orderable = files.placeFolder !== undefined && source.paths.length === 1 && !copying;
      const zone = dropZoneAt(at, { kind: "folder", expanded: files.expanded.has(path) }, orderable);
      const plan = planTreeDrop({ paths: source.paths, target: path, zone, listings: files.listings, descending, copying });
      return { zone, plan };
    };

    /** The existing drop into a folder: `dnd.ts` decides, the browser moves or copies. */
    const dropInto = (source: DragSource, path: string, modifiers: readonly DragModifier[]) => {
      /*
        Picked rows already in the drop folder stay where they are rather
        than refusing the whole drop as "already there" — dragging three
        notes from two folders into one of those two is a move of the ones
        that are elsewhere. A copy keeps them all: a copy into its own folder
        is a duplicate, and legal. Dropping only rows that are already there
        keeps the refusal, which is the answer a single row gets.
      */
      const elsewhere = source.paths.filter((each) => parentPath(each) !== path);
      const moving =
        modifiers.includes("copy") || elsewhere.length === 0 ? source : { ...source, paths: elsewhere };
      const verdict = verdictFor(moving, { kind: "folder", path }, modifiers, files.listings);
      if (!verdict.ok) {
        // The refusal is the product of `dnd.ts`, said in words rather than
        // by the row simply springing back. A drop that fails silently
        // teaches nothing.
        refuse(verdict.reason);
        return;
      }
      if (verdict.moves.length > 1) {
        // One operation with one Undo, not a loop — see `moveMany` in
        // `browser.ts`. The browser re-checks the same rules on the way in.
        const from = verdict.moves.map((move) => move.from);
        if (verdict.action === "copy") files.copyManyTo(from, path);
        else files.moveMany(from, path);
        setPicked(NO_PICK);
        return;
      }
      for (const move of verdict.moves) {
        const destination = parentPath(move.to);
        // `copyTo`, not `copy` + `paste`: back to back in one tick the paste
        // reads the *previous* clipboard. `copyTo` takes the source as an
        // argument and cannot be wrong about it.
        if (verdict.action === "copy") files.copyTo(move.from, destination);
        else files.move(move.from, destination);
      }
      // A pick whose other rows were already in the drop folder came down
      // to this one move, and it is spent all the same.
      setPicked(NO_PICK);
    };

    return {
      canDrag: (row) => !row.readOnly && row.kind !== "loading" && row.kind !== "empty",
      canDrop: (row) => row.kind === "folder",
      onDragStart: (path) => {
        /*
          Picking up one of several picked rows picks up all of them, the way
          every file manager does; picking up any other row is a drag of that
          row alone, and ends the pick for the same reason a right-click
          outside it does.
        */
        const carried =
          pickedRows.length > 1 && shown.paths.has(path) ? pickedRows.map((row) => row.path) : [path];
        if (carried.length === 1 && shown.paths.size > 0) setPicked(NO_PICK);
        setDrag({
          paths: carried,
          readOnly: carried.some((each) => findEntry(files.listings, each)?.readOnly ?? false),
        });
      },
      onDragOver: (path, modifiers, at) => {
        if (drag === null) return;
        const { zone, plan } = planAt(drag, path, modifiers, at);
        // Nothing is drawn where nothing would happen, or where the drop is refused.
        const next = plan.kind === "refuse" || plan.kind === "none" ? null : { path, zone };
        // `dragover` fires every few milliseconds: redraw only when the answer changes.
        setDropTarget((current) =>
          current?.path === next?.path && current?.zone === next?.zone ? current : next,
        );
      },
      onDragLeave: (path) => setDropTarget((current) => (current?.path === path ? null : current)),
      onDragEnd: () => {
        setDrag(null);
        setDropTarget(null);
      },
      onDrop: (path, modifiers, at) => {
        const source = drag;
        setDrag(null);
        setDropTarget(null);
        if (source === null) return;
        const { plan } = planAt(source, path, modifiers, at);
        switch (plan.kind) {
          case "nest":
            return dropInto(source, plan.folder, modifiers);
          case "reorder":
            return files.placeFolder?.(source.paths[0]!, plan.parent, plan.folders);
          case "place":
            return files.placeFolder?.(plan.from, plan.parent, plan.folders);
          case "refuse":
            return refuse(plan.reason);
          case "none":
            return;
        }
      },
    };
  }, [descending, drag, files, pickedRows, refuse, setPicked, shown]);

  return { dragHandlers, dropTarget };
}
