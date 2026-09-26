import { useCallback, useEffect, useMemo, useState } from "react";
import { writeClipboard } from "../../../design/clipboard";
import { isApplePlatform } from "../../../design/applePlatform";
import type { useFrame } from "../../../app/AppFrame";
import type { FileBrowser } from "../browser";
import { canDrop as verdictFor, type DragSource } from "../dnd";
import type { TreeDragHandlers } from "../FileTree";
import { useListingOrder } from "../listingOrder";
import { itemsFor, type MenuActionId, type MenuTarget } from "../menu";
import { runMenuAction, type ActionContext, type Dialog } from "../actions";
import { useRightClick } from "../rightClick";
import { baseName, folderLabel, parentPath } from "../paths";
import { itemsFromListings, rank } from "../palette";
import { NO_PICK, type TreePick } from "../selection";
import { buildTreeRows, findEntry, targetFolder, type TreeRow } from "../tree";
import type { MenuState } from "./menuState";
import type { ExplorerProps } from "./props";
import { inheritedOf } from "./rowVisibility";
import { useActivityMarks } from "./useActivityMarks";
import { useTreePick } from "./useTreePick";

/**
 * Everything `Explorer` holds and every command it can run: the filter, the
 * pick, the row menu, the dialogs, dragging, and the foot's lists.
 *
 * One hook rather than several because the setters and the callbacks that
 * call them have to live in the same function for `react-hooks` to see that
 * those setters are stable — split apart, every dependency array here would
 * need them listed. The pieces that need no setter of this hook's own are
 * `useTreePick` and `useActivityMarks`, called at the point they always ran.
 */
export function useExplorer({
  files,
  contextLabel,
  onOpenPinned,
  onOverlayChange,
  pickProp,
  onPickChange,
  activity,
  agents,
  frame,
}: {
  files: FileBrowser;
  contextLabel: string;
  onOpenPinned: ExplorerProps["onOpenPinned"];
  onOverlayChange: ExplorerProps["onOverlayChange"];
  pickProp: ExplorerProps["pick"];
  onPickChange: ExplorerProps["onPickChange"];
  activity: ExplorerProps["activity"];
  agents: ExplorerProps["agents"];
  frame: ReturnType<typeof useFrame>;
}) {
  /*
    The sort control's whole state. Two orders and not a menu of five, because
    two is what one press can carry and because the only field the console has
    to sort on is the name — `FolderListing` has no sizes for a folder and the
    dates it does carry are the bucket's, not the note's.
  */
  /*
    Shared with the folder page rather than held here — see `listingOrder.ts`.
    It used to be this component's own `useState`, which meant the sort reached
    the tree and not the listing of the very same folder drawn beside it.
  */
  const descending = useListingOrder();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [ownPick, setOwnPick] = useState<TreePick>(NO_PICK);
  const picked = pickProp ?? ownPick;
  const setPicked = onPickChange ?? setOwnPick;
  /**
   * Whether the activity list is up, and the moment it was opened.
   *
   * The moment is state rather than a fresh `Date.now()` per render: every
   * relative time in the list has to agree with the line that opened it, and a
   * clock read during render makes "4 min" tick over mid-scroll.
   */
  const [activityOpen, setActivityOpen] = useState<number | null>(null);
  /** The agents list, and the moment it was opened, on the same terms. */
  const [agentsOpen, setAgentsOpen] = useState<number | null>(null);

  /*
    Tell the frame while this region owns something modal, so the keyboard goes
    to `overlay` scope and nothing behind it fires. Without it, ⌘K opens the
    palette behind an open context menu.
  */
  const overlayOpen = menu !== null || dialog !== null;
  useEffect(() => {
    onOverlayChange?.(overlayOpen);
  }, [overlayOpen, onOverlayChange]);

  /*
    Everything here names a note in a context, so changing context ends it.

    `<Explorer>` is mounted in `app/(app)/console/_layout.tsx` — in the layout,
    above `<Slot/>` — so it survives `/console/@a` to `/console/@b`, and all of
    this is ordinary `useState` that nothing was resetting. Each one that
    outlives a switch is a control aimed at a context nobody is in any more:

      dialog       the share dialog stayed open titled after the old note, and
                   submitting called the NEW context's `share` with the OLD
                   context's path. `createShare` checks the role and the path's
                   syntax, never that the path exists in that workspace.
      menu         worse, because `duplicate`, `copy`, `cut`, `paste`, `restore`
                   and the three visibility actions fire straight from
                   `runAction` with no dialog in between — one click.
      drag         worst: a pending drag dropped into the new context's tree is
                   a `move`, which is destructive rather than a read grant. And
                   `onDragEnd` cannot save it — the source row is unmounted by
                   the re-render, so its listener is gone and `dragend` never
                   arrives.

    A `key` on the mount site would be the structural form of this and would
    cover state added later, which an enumeration cannot — this list reached
    three instances in two passes. It is not taken because nothing in the suite
    mounts that layout, so the guard would be unverifiable, and an unchecked
    guard is the failure this file's neighbours keep recording. Filed rather
    than assumed away.

    `setDropTarget(null)` alone fails nothing when removed, and that is stated
    rather than left ambiguous: `dropTarget` is a row highlight, and `drag`
    being null already refuses the drop, so losing it costs a stale outline on
    a row in the new context and no more. It is kept because the pair is one
    gesture and splitting them invites the next reader to wonder which half
    mattered.

    Keyed on `contextLabel` because it is what identifies whose tree this is.
    Slugs are globally unique and cannot contain `@` or a space, so no two
    contexts share a label and the unresolved fallback cannot alias one.
  */
  useEffect(() => {
    setDialog(null);
    setMenu(null);
    setDrag(null);
    setDropTarget(null);
    setRefusal(null);
    setPicked(NO_PICK);
  }, [contextLabel, setPicked]);



  const treeRows = useMemo(
    () =>
      buildTreeRows({
        listings: files.listings,
        expanded: files.expanded,
        selectedPath: files.selectedPath,
        descending,
      }),
    [descending, files.expanded, files.listings, files.selectedPath],
  );

  const { shown, rows, pickedRows, onPick } = useTreePick({
    treeRows,
    picked,
    setPicked,
    files,
    overlayOpen,
  });

  const matches = useMemo(() => {
    if (query.trim() === "") return null;
    return rank(query, itemsFromListings(files.listings));
  }, [query, files.listings]);

  const selectedFolder = targetFolder(files.listings, files.selectedPath);

  /**
   * Choosing a note, and putting the tree away if the tree is over the note.
   *
   * `closesOnSelect` is true exactly when this tree is drawn *over* the editor
   * rather than beside it, which on a pointer layout means the peek — the tree
   * brought back over the note while the pointer rests on its folded seam. It
   * is covering the thing you just asked to read, so leaving it up opens every
   * note behind a panel.
   *
   * **`closeOverlays` rather than `closeDrawer`**, which is the change the peek
   * forced and the right one anyway: this call site wants "put away whatever is
   * over the editor", and `closeDrawer` names one particular panel. It was
   * correct while the drawer was the only one; it would silently do nothing now.
   *
   * `useCallback` because `runAction` depends on it: a plain arrow is a new
   * identity every render, which would rebuild that callback on every keystroke
   * in the filter box.
   */
  const select = useCallback(
    (path: string) => {
      // A plain click ends a pick, even on the row already open — that is
      // the click that says "just this one".
      setPicked(NO_PICK);
      files.select(path);
      if (frame.closesOnSelect) frame.closeOverlays();
    },
    [files, frame, setPicked],
  );

  /* ---------------------------------------------------------------------- */
  /*                          the row's own menu                              */
  /* ---------------------------------------------------------------------- */

  /**
   * `"web"` outright, not derived from a density that has one value here.
   *
   * `menu.ts` forks on this: a `web` menu prints the keyboard chord beside each
   * item and offers "Open in new tab", a `touch` one does neither. **This
   * region only exists on a pointer layout** — see the file header — so there
   * is a keyboard, there is room for a shortcut column, and there are tabs.
   * Computing it from `frame.density` was the pretence that a phone could reach
   * this tree; the honest form is the literal, and `menu.ts`'s own header
   * records who the `touch` arm is waiting for.
   */
  const platform = "web" as const;

  const openTarget = useCallback(
    (target: MenuTarget, title: string, anchor: { x: number; y: number }) => {
      const items = itemsFor({
        target,
        canEdit: files.canEdit,
        canSetVisibility: files.canSetVisibility,
        canShare: files.canShare,
        canDownload: files.canDownload,
        clipboard: files.clipboard,
        platform,
        // Read, never assumed. `menu.ts` defaults this to Apple, which prints
        // `⌘⇧M` on Windows beside a row whose chord is actually `Ctrl+Shift+M`.
        apple: isApplePlatform(),
        // What the row would be visible to with no setting of its own, so the
        // visibility submenu can say what "use the folder's setting" means
        // rather than leaving it as a verb with an invisible outcome.
        ...(target.kind === "row"
          ? { inherited: inheritedOf(files, target.row.path) }
          : {}),
      });
      // An empty menu is not an empty menu — it is no menu. Opening a bordered
      // rectangle with nothing in it reads as a bug.
      if (items.length === 0) return false;
      setMenu({ target, title, anchor, items });
      return true;
    },
    /*
      `files` whole, rather than the four fields off it this reads.

      It used to name them — `canEdit`, `canSetVisibility`, `canShare`,
      `clipboard` — and the reason that list existed is still the reason this
      array matters, so it is worth keeping: `canSetVisibility` and `canShare`
      are each `canEdit && isOwner`, so they move *independently* of `canEdit`,
      and `<Explorer>` is mounted without a `key` in a layout that survives a
      context switch. Owning one context and merely editing the next therefore
      keeps `canEdit` true while ownership goes away, and a callback holding a
      stale copy went on offering the owner-only submenu to somebody the server
      refuses.

      Depending on the object closes that by construction instead of by
      enumeration. `files` is memoized over every field it carries, so it
      changes whenever any of the four does — this can no longer be stale, and
      it can no longer be made stale by a fifth field being read here and not
      added to a list. `explorerMenuStaleGate.test.ts` still holds it either
      way, which is what makes the swap checkable rather than asserted.
    */
    [files, platform],
  );

  /** What `FileTree` hands up: a row and where the pointer was. */
  const openMenu = useCallback(
    // Named without its sort number, the way the row it came out of is: a menu
    // headed `1-projects` over a row reading `projects` is a menu the reader
    // has to match up to the thing they just pressed.
    (row: TreeRow, anchor: { x: number; y: number }) => {
      /*
        Right-clicking one of several picked rows is a menu for all of them;
        right-clicking a row outside the pick is a menu for that row, and ends
        the pick — the way Finder and VS Code both answer it. Leaving the pick
        drawn under a menu for some other row would put two answers to "what
        will this act on" on screen at once.
      */
      if (pickedRows.length > 1 && shown.paths.has(row.path)) {
        return openTarget(
          { kind: "selection", rows: pickedRows },
          `${pickedRows.length} items`,
          anchor,
        );
      }
      if (shown.paths.size > 0) setPicked(NO_PICK);
      return openTarget({ kind: "row", row }, folderLabel(baseName(row.path)), anchor);
    },
    [openTarget, pickedRows, setPicked, shown],
  );

  /**
   * The tree's own empty space, below the last row.
   *
   * It is the context root that a creation lands in, because that is the folder
   * this column is a listing of. `menu.ts` returns nothing at all for a
   * read-only console, and `openTarget` declines to open an empty popover, so
   * the gesture falls through to the browser there — which is the right answer
   * when the application has nothing to offer.
   */
  const openRightClick = useCallback(
    (anchor: { x: number; y: number }) =>
      openTarget({ kind: "background", folder: "" }, contextLabel, anchor),
    [openTarget, contextLabel],
  );

  const background = useRightClick(files.canEdit ? openRightClick : undefined);

  /**
   * The dispatcher's world, assembled once.
   *
   * Every arm of `runMenuAction` is a `FileBrowser` call, a dialog or one of
   * these callbacks, and this region supplies the three it can: opening a path,
   * raising a dialog, and pinning a tab. It supplies no `reveal` and no
   * `closeTabs` — the tree *is* what reveal reveals into, and the tab strip is
   * a different region — which is why `menu.ts` offers neither item on a tree
   * row.
   */
  const menuActions = useMemo<ActionContext>(
    () => ({
      files,
      contextLabel,
      select,
      setDialog,
      writeClipboard: (text) => void writeClipboard(text),
      ...(onOpenPinned === undefined ? {} : { openPinned: onOpenPinned }),
      inheritedOf: (path) => inheritedOf(files, path),
    }),
    [files, contextLabel, select, onOpenPinned],
  );

  const runAction = useCallback(
    (id: MenuActionId, target: MenuTarget) => {
      runMenuAction(id, target, menuActions);
      // The pick has been spent on whatever was chosen — copying its paths
      // aside, which leaves the rows where they were and still picked.
      if (target.kind === "selection" && id !== "copyPath") setPicked(NO_PICK);
    },
    [menuActions, setPicked],
  );

  /* ---------------------------------------------------------------------- */
  /*                                 dragging                                 */
  /* ---------------------------------------------------------------------- */

  const dragHandlers = useMemo<TreeDragHandlers | undefined>(() => {
    if (!files.canEdit) return undefined;
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
          pickedRows.length > 1 && shown.paths.has(path)
            ? pickedRows.map((row) => row.path)
            : [path];
        if (carried.length === 1 && shown.paths.size > 0) setPicked(NO_PICK);
        setDrag({
          paths: carried,
          readOnly: carried.some((each) => findEntry(files.listings, each)?.readOnly ?? false),
        });
      },
      onDragOver: (path) => setDropTarget(path),
      onDragLeave: (path) => setDropTarget((current) => (current === path ? null : current)),
      onDragEnd: () => {
        setDrag(null);
        setDropTarget(null);
      },
      onDrop: (path, modifiers) => {
        const source = drag;
        setDrag(null);
        setDropTarget(null);
        if (source === null) return;

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
          modifiers.includes("copy") || elsewhere.length === 0
            ? source
            : { ...source, paths: elsewhere };
        const verdict = verdictFor(moving, { kind: "folder", path }, modifiers, files.listings);
        if (!verdict.ok) {
          // The refusal is the product of `dnd.ts`, said in words rather than
          // by the row simply springing back. A drop that fails silently
          // teaches nothing.
          setMenu(null);
          setRefusal(verdict.reason);
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
          if (verdict.action === "copy") {
            // `copyTo`, not `copy` + `paste`. Those two are a state setter and
            // a callback closing over that state, so back to back in one tick
            // the paste reads the *previous* clipboard: with a cut pending it
            // moved a file the user had never touched. `copyTo` takes the
            // source as an argument and cannot be wrong about it.
            files.copyTo(move.from, destination);
          } else {
            files.move(move.from, destination);
          }
        }
        // A pick whose other rows were already in the drop folder came down
        // to this one move, and it is spent all the same.
        setPicked(NO_PICK);
      },
    };
  }, [files, drag, pickedRows, setPicked, shown]);

  const { counts, activityLabel, markedPaths, agentMarks, agentsLabel, sheetLift } =
    useActivityMarks({ files, activity, agents, activityOpen });

  /**
   * Putting the filter away, which must also clear it.
   *
   * A hidden field whose query is still filtering is a tree that is missing
   * files with nothing on screen saying why — and on a phone the field is
   * hidden by default, so that state would be reachable by rotating a tablet
   * with a query in it. One handler for both the pointer's × and the phone's
   * close, so the two cannot come to disagree about whether closing clears.
   */
  const closeFilter = useCallback(() => setQuery(""), []);

  return {
    descending,
    query,
    setQuery,
    dialog,
    setDialog,
    menu,
    setMenu,
    dropTarget,
    refusal,
    setRefusal,
    setPicked,
    activityOpen,
    setActivityOpen,
    agentsOpen,
    setAgentsOpen,
    rows,
    onPick,
    matches,
    selectedFolder,
    select,
    openMenu,
    background,
    runAction,
    dragHandlers,
    counts,
    activityLabel,
    markedPaths,
    agentMarks,
    agentsLabel,
    sheetLift,
    closeFilter,
  };
}

/** What `useExplorer` hands back, for the regions that draw it. */
export type ExplorerState = ReturnType<typeof useExplorer>;
