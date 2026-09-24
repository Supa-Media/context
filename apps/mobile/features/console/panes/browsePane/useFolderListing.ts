import { useCallback, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { densityFor } from "../../../app/frame";
import { isApplePlatform } from "../../../design/applePlatform";
import { writeClipboard } from "../../../design/clipboard";
import type { ActionContext, Dialog } from "../../files/actions";
import type { FileBrowser } from "../../files/browser";
import { itemsFor, type MenuTarget } from "../../files/menu";
import { ancestorsOf, baseName, folderLabel, parentPath } from "../../files/paths";
import { canDrop as verdictFor, type DragSource } from "../../files/dnd";
import type { FolderDrag, FolderMenu } from "../../files/FolderView";
import { findEntry, treeRowFor } from "../../files/tree";
import type { ConsoleData, selectedContext } from "../../types";
import type { FolderMenuState } from "./folderMenuState";
import { useBrowseEncryption } from "./useBrowseEncryption";

/**
 * The folder listing's right-click menu, the dialogs it leads to, and dragging
 * rows out of a listing — the state and the commands together, so
 * `react-hooks` can see the setters the commands call are stable.
 *
 * The note-encryption hooks and the pane's density have always run between
 * this state and these commands, so they are called from here, at that same
 * point, and handed back.
 */
export function useFolderListing({
  files,
  contextLabel,
  settled,
  current,
  data,
}: {
  files: FileBrowser;
  contextLabel: string;
  settled: boolean;
  current: ReturnType<typeof selectedContext>;
  data: ConsoleData;
}) {
  /* ------------------------------------------------------------------ */
  /*                   the folder listing's right-click                  */
  /* ------------------------------------------------------------------ */

  /**
   * The menu `FolderView` raises, and the dialogs it leads to.
   *
   * This pane owns both because `FolderView` is a drawing of a folder and
   * knows nothing about a `FileBrowser` — the same split `Explorer` makes with
   * `FileTree`. What was here before was nothing at all: the listing bound no
   * pointer gesture, so a right-click on the largest surface in the console
   * reached the document and opened the *browser's* menu over somebody's notes.
   */
  const [folderMenu, setFolderMenu] = useState<FolderMenuState>(null);
  const [folderDialog, setFolderDialog] = useState<Dialog>(null);
  /**
   * What is being dragged out of the listing, and what it is over.
   *
   * The tree has had this since `dnd.ts` was written; a folder *page* had
   * nothing, so a folder you could reorganise by dragging while it was a row
   * in the sidebar went inert the moment you opened it — and on a phone, where
   * there is no sidebar at all, there was no drag anywhere.
   *
   * Held here rather than in `FolderView` for the reason its menu is: the
   * component draws a folder and knows nothing about a `FileBrowser`. The
   * state is the same pair `Explorer` keeps, and the verdict comes from the
   * same `dnd.ts` call, so a drop the tree refuses is refused identically
   * here.
   */
  const [folderDragSource, setFolderDrag] = useState<DragSource | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);

  const encryption = useBrowseEncryption({ settled, current, data, files });

  /*
    The note runs to the edges of the glass on a phone, and the padding that
    used to sit here belongs to the document instead — see `NoteEditor`. A
    16pt frame around a note *plus* the note's own reading margin is 36pt of
    gutter on a 390pt screen, and it is what made the measure wrap every six
    words in the before shot.
  */
  const compact = densityFor(useWindowDimensions().width) === "compact";

  /**
   * Build the menu for one target, or decline.
   *
   * Returns whether it opened — `rightClick.web.ts` suppresses the browser's
   * own menu only on a `true`, so an empty list here leaves the platform menu
   * alone rather than eating the gesture and showing nothing.
   */
  const openFolderTarget = useCallback(
    (target: MenuTarget, title: string, anchor: { x: number; y: number }) => {
      const items = itemsFor({
        target,
        canEdit: files.canEdit,
        canSetVisibility: files.canSetVisibility,
        // Offered here exactly as it is in the tree: downloading is a read of
        // the row you right-clicked, so it needs none of the per-note state
        // the share dialog below does.
        canDownload: files.canDownload,
        /*
          Deliberately false, and this is the one item the listing offers less
          of than the tree does.

          Sharing a note opens a dialog about *that note's* access, and the
          members, groups and removal routes it needs are assembled in this
          pane for the **selected** note — a row you have right-clicked in a
          listing is not that. `ExplorerDialogs` would happily draw the dialog
          without them, and a share sheet that cannot show who currently has
          access is worse than no share sheet in a product where `team` means
          named people. So the item is absent rather than half-working, and
          sharing stays where it already is: open the note, use the frame's
          own share control.
        */
        canShare: false,
        clipboard: files.clipboard,
        /*
          The `touch` arm's first real caller, and exactly what it was kept for.

          This pane *is* the phone's browse surface — there is no file tree at
          compact density (`frame.ts`) and no tab strip either — so a menu here
          must print no keyboard chords and must not offer "Open in new tab".
          A phone browser raises `contextmenu` on a long press, so the gesture
          genuinely arrives; without this it would arrive at a pointer menu.
        */
        platform: compact ? "touch" : "web",
        apple: isApplePlatform(),
        // What the row would be visible to with no setting of its own, so
        // "use the folder's setting" can say what it means.
        ...(target.kind === "row"
          ? { inherited: findEntry(files.listings, target.row.path)?.inherited }
          : {}),
      });
      if (items.length === 0) return false;
      setFolderMenu({ target, title, anchor, items });
      return true;
    },
    [files, compact],
  );

  /**
   * The dispatcher's world for this pane.
   *
   * No `openPinned`, no `reveal`, no `closeTabs`: the tab strip and the file
   * tree are other regions, and `menu.ts` withholds every item that would need
   * one. `runMenuAction` degrades rather than throwing if that ever stops being
   * true, and `menuActions.test.ts` holds it to that.
   */
  const menuActions = useMemo<ActionContext>(
    () => ({
      files,
      contextLabel,
      select: files.select,
      setDialog: setFolderDialog,
      writeClipboard: (text) => void writeClipboard(text),
      /**
       * Put the tree on a folder: open every ancestor, then select it.
       *
       * `toggleFolder` *toggles*, so an ancestor that is already open would be
       * closed by a blind call — the check is what makes this "reveal" rather
       * than "flip everything on the way down". `ancestorsOf` owns the path
       * arithmetic, as it does for every other caller.
       *
       * Select last, so the row it lands on is one the tree has been told to
       * draw.
       */
      reveal: (path) => {
        for (const ancestor of ancestorsOf(path)) {
          if (!files.expanded.has(ancestor)) files.toggleFolder(ancestor);
        }
        files.select(path);
      },
      inheritedOf: (path) => findEntry(files.listings, path)?.inherited ?? "private",
    }),
    [files, contextLabel],
  );

  /**
   * Right-click on a breadcrumb segment.
   *
   * The fastest route to a parent folder's verbs, and it offered none of them.
   * Same menu the tree gives that folder, minus what you must not do to the
   * ground you are standing on — see `crumbItems` in `menu.ts`.
   */
  const openCrumbMenu = useCallback(
    (folder: string, anchor: { x: number; y: number }) =>
      openFolderTarget(
        { kind: "crumb", folder },
        // Titled the way the crumb it opened from is drawn — see `crumbsFor`.
        folderLabel(baseName(folder)) || contextLabel,
        anchor,
      ),
    [openFolderTarget, contextLabel],
  );

  /**
   * The pair of handlers one folder's listing needs.
   *
   * Built per folder rather than once, because "where does a new note go" is
   * the folder being *drawn* — the landing page draws the root, a selected
   * folder draws itself, and a single shared handler would have to guess which.
   */
  const folderMenuFor = useCallback(
    (folder: string): FolderMenu => ({
      onRow: (entry, anchor) => {
        // The listing's own default, so the row's marker — which is what
        // `menu.ts` reads to decide which visibility is in force — is the same
        // one the tree would have computed for it.
        const row = treeRowFor(entry, files.listings[folder]?.folderDefault ?? "private");
        // Named the way the row it came out of is — see `openMenu` in
        // `Explorer.tsx`, which titles the tree's own menu the same way.
        return openFolderTarget(
          { kind: "row", row },
          folderLabel(baseName(entry.path)),
          anchor,
        );
      },
      onBackground: (anchor) =>
        openFolderTarget(
          { kind: "background", folder },
          folderLabel(baseName(folder)) || contextLabel,
          anchor,
        ),
    }),
    [openFolderTarget, files.listings, contextLabel],
  );

  /**
   * Picking a row up out of a listing and dropping it on another.
   *
   * Built once rather than per folder, unlike `folderMenuFor`: a drag carries
   * its source with it and every rule below is asked of the *row*, so there is
   * nothing here that depends on which folder is being drawn.
   *
   * What is deliberately the same as the tree:
   *
   *  - **The verdict.** `dnd.ts`'s `canDrop` decides, over `files.listings`,
   *    exactly as it does for `Explorer` — so a folder dropped into itself,
   *    a name that would collide, and a read-only `privacy.md` are refused
   *    with the same sentence on both surfaces. This file re-deriving any of
   *    that is how the two come to disagree about what the same product does.
   *  - **`copyTo` and not `copy` + `paste`.** Those two are a state setter and
   *    a callback closing over that state, so back to back in one tick the
   *    paste reads the *previous* clipboard — with a cut pending it moved a
   *    file nobody had touched. `Explorer` learned this; the copy of the loop
   *    here must not unlearn it.
   *  - **A refusal is said out loud.** `files.say` is the transient line a
   *    refused paste already uses. A row that springs back in silence teaches
   *    nothing, which is most of why people try the same illegal drop twice.
   *
   * Absent entirely on a read-only console, so nothing carries `draggable` —
   * see `FolderDrag`.
   */
  const folderDrag = useMemo<FolderDrag | undefined>(() => {
    if (!files.canEdit) return undefined;
    return {
      // `privacy.md` is generated, so the row that draws it is never a source.
      canDrag: (entry) => !entry.readOnly,
      canDrop: (entry) => entry.kind === "folder",
      onDragStart: (path) =>
        setFolderDrag({
          paths: [path],
          readOnly: findEntry(files.listings, path)?.readOnly ?? false,
        }),
      onDragOver: (path) => setFolderDropTarget(path),
      onDragLeave: (path) =>
        setFolderDropTarget((current) => (current === path ? null : current)),
      onDragEnd: () => {
        setFolderDrag(null);
        setFolderDropTarget(null);
      },
      onDrop: (path, modifiers) => {
        const source = folderDragSource;
        setFolderDrag(null);
        setFolderDropTarget(null);
        if (source === null) return;
        const verdict = verdictFor(source, { kind: "folder", path }, modifiers, files.listings);
        if (!verdict.ok) return files.say(verdict.reason);
        for (const move of verdict.moves) {
          const destination = parentPath(move.to);
          if (verdict.action === "copy") files.copyTo(move.from, destination);
          else files.move(move.from, destination);
        }
      },
      target: folderDropTarget,
    };
  }, [files, folderDragSource, folderDropTarget]);

  return {
    folderMenu,
    setFolderMenu,
    folderDialog,
    setFolderDialog,
    encryption,
    compact,
    menuActions,
    openCrumbMenu,
    folderMenuFor,
    folderDrag,
  };
}

/** What `useFolderListing` hands back. */
export type FolderListingState = ReturnType<typeof useFolderListing>;
