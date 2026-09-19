import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon, type IconName } from "../../design/components/Icon";
import { Menu } from "../../design/components/Menu";
import { Text } from "../../design/components/Text";
import { writeClipboard } from "../../design/clipboard";
import { isApplePlatform } from "../../design/applePlatform";
import { pointerType as t, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFrame } from "../../app/AppFrame";
import { loadedFolders, type FileBrowser } from "./browser";
import { loadedCounts } from "./contextFoot";
import {
  Confirm,
  CreatePrompt,
  MovePicker,
  NamePrompt,
  NEW_FOLDER_HINT,
} from "./Dialogs";
import { ShareDialog } from "./ShareDialog";
import type { AudienceContext } from "../privacy/audience";
import { consoleOrigin } from "./shareOrigin";
import { sharesBreakingWarning } from "./shares";
import { canDrop as verdictFor, type DragSource } from "./dnd";
import { FileTree, type TreeDragHandlers } from "./FileTree";
import { setListingOrder, useListingOrder } from "./listingOrder";
import { itemsFor, type MenuActionId, type MenuTarget } from "./menu";
import { runMenuAction, type ActionContext, type Dialog } from "./actions";
import { useRightClick } from "./rightClick";
import { baseName, parentPath, withoutSortPrefix } from "./paths";
import { itemsFromListings, rank } from "./palette";
import { buildTreeRows, findEntry, targetFolder, type TreeRow } from "./tree";
import type { AccessMember, AccessRow, RemovalRoute } from "./access";
import type { RecipientGroup } from "./recipients";
import { isGroupVisibility } from "./types";
import type { Visibility } from "./types";

/**
 * The file tree, as a region of the application rather than a box inside a pane.
 *
 * It used to be a 246px column with a hard `maxHeight: 432`, sitting inside the
 * Browse pane's content area, inside a page that scrolled — so the tree scrolled
 * within a box within a scrolling document, and a context with a few hundred
 * notes was unusable. Here it owns a region: it fills the height available, it
 * is the only thing that scrolls inside itself, and on a wide window it can be
 * dragged wider.
 *
 * ## The toolbar is one button, not three
 *
 * Browse carried a permanent "New note" / "New folder" / "Paste …" row. Those
 * are now a single `+`, because creating something is one intent with two
 * shapes, and because the operations that used to need buttons are reachable
 * where they belong — on the row itself, through a right-click on a pointer and
 * a long press under a thumb.
 *
 * ## This is a pointer-layout region, and it draws one presentation
 *
 * **Two whole density forks lived here and neither could ever run.** This file
 * carried a `const touch = frame.density === "compact"` and branched on it a
 * dozen times: a footer icon row in place of the header toolbar, a filter that
 * was a revealed field rather than a permanent one, an autofocus, a "Close the
 * file tree" button, thumb-sized targets, and a `touch` prop handed down to
 * `FileTree`. `<Explorer>` is mounted only where `regions.explorer` is `column`
 * or `drawer`, and `frame.ts` answers `hidden` at `compact` — so `touch` was
 * permanently `false` and every one of those branches was unreachable, along
 * with the prose arguing for them.
 *
 * That prose is not simply deleted, because what it argued for was right and is
 * worth being able to find: it described Obsidian mobile's sidebar — the verbs
 * at the *foot* of the panel where a thumb is, the filter as a magnifier that
 * reveals a field rather than a permanent one opening a soft keyboard over the
 * tree it filters. It is in the history, and the reference it was measured
 * against is in `docs/design/obsidian-parity`. What is not kept is code nothing
 * can reach: a phone has no file tree at all (`features/app/frame.ts`), and its
 * browse surface is `FolderView` — a flat listing of the folder you are in,
 * with its own thumb sizing.
 *
 * The one piece of the fork that stays is `frame.closesOnSelect` below, and it
 * stays for the reason `frame.ts` gives in the enumeration in its own header:
 * that is `AppFrame`'s API, held by callers outside this feature, and retiring
 * it is one change made where they are rather than a hole opened here.
 *
 * ## Filtering flattens, deliberately
 *
 * A filtered tree that keeps its hierarchy has to decide what to do with a
 * folder whose name does not match but whose children do, and every answer is
 * confusing: hide it and the matches vanish, show it and the "filtered" tree
 * still contains non-matching rows. So a query switches to a flat ranked list —
 * the same ranking the palette uses, so the two cannot disagree about what
 * "best match" means — and clearing it returns you to the tree with your
 * expansion state untouched.
 */
export function Explorer({
  files,
  contextLabel,
  onOpenPinned,
  onOverlayChange,
  access,
  workspaces,
}: {
  files: FileBrowser;
  /**
   * The workspace row that ends the column — `ContextFootRow`.
   *
   * A slot rather than something this component builds, for the same reason the
   * `vault` slot that used to sit here was one: the row needs the context list,
   * the recently-visited log and the router, none of which this component has
   * or should acquire. `undefined` where there is nowhere to switch to, and the
   * column then ends at the counts line exactly as it did before.
   */
  workspaces?: ReactNode;
  /** Handed straight to the share dialog. See `ExplorerDialogs`. */
  access?: {
    members: readonly AccessMember[];
    groups?: readonly RecipientGroup[];
    /**
     * `kind` travels with the path because a folder and a note go to different
     * actions — the note one refuses anything that is not `.md`, which is the
     * refusal an owner met when this dropped it.
     */
    onShareWithGroup?: (path: string, kind: "file" | "folder", group: string) => void;
    /**
     * What a row in the people list can do about somebody, for one path.
     *
     * A factory rather than a handler, because narrowing a note names the
     * note and this component is rendered once for a tree with many. Returns
     * `undefined` for a caller that can do none of it — see `removalHandler`
     * — and the dialog then draws roles rather than controls.
     */
    removalRouteFor?: (
      path: string,
      /** Decides which visibility mutation the narrow route means. */
      kind: "file" | "folder",
    ) => ((route: RemovalRoute, row: AccessRow) => void) | undefined;
    /** The workspace's slug, for showing the name a new group's label becomes. */
    groupSlug?: string;
    /** Whose context this is, so every audience can be named. */
    audience?: AudienceContext;
    /**
     * Make a group and point this path at it. Owner-only upstream.
     *
     * Answers, so the sheet can show a refusal from the control plane where
     * the person can read it — the notice line sits behind the modal.
     */
    onCreateGroup?: (
      path: string,
      /** Same reason `onShareWithGroup` carries one: it ends in the same call. */
      kind: "file" | "folder",
      label: string,
      userIds: readonly string[],
    ) => Promise<unknown>;
  };
  /** "@seyi" — named in the empty state so it is obvious whose tree this is. */
  contextLabel: string;
  /**
   * "Open in new tab" — opens the note *pinned*, where a plain open leaves a
   * preview tab the next click replaces. Absent where there are no tabs, and
   * `menu.ts` is then the thing that must not offer the item.
   */
  onOpenPinned?: (path: string) => void;
  /**
   * Raised while this region owns a menu or a dialog, so the frame can put the
   * keyboard into `overlay` scope. Without it, ⌘K opens the palette *behind* an
   * open context menu.
   */
  onOverlayChange?: (open: boolean) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const frame = useFrame();
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
  }, [contextLabel]);



  const rows = useMemo(
    () =>
      buildTreeRows({
        listings: files.listings,
        expanded: files.expanded,
        selectedPath: files.selectedPath,
        descending,
      }),
    [descending, files.expanded, files.listings, files.selectedPath],
  );

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
      files.select(path);
      if (frame.closesOnSelect) frame.closeOverlays();
    },
    [files, frame],
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
    (row: TreeRow, anchor: { x: number; y: number }) =>
      openTarget({ kind: "row", row }, withoutSortPrefix(baseName(row.path)), anchor),
    [openTarget],
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
    (id: MenuActionId, target: MenuTarget) => runMenuAction(id, target, menuActions),
    [menuActions],
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
        const entry = findEntry(files.listings, path);
        setDrag({ paths: [path], readOnly: entry?.readOnly ?? false });
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

        const verdict = verdictFor(source, { kind: "folder", path }, modifiers, files.listings);
        if (!verdict.ok) {
          // The refusal is the product of `dnd.ts`, said in words rather than
          // by the row simply springing back. A drop that fails silently
          // teaches nothing.
          setMenu(null);
          setRefusal(verdict.reason);
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
      },
    };
  }, [files, drag]);

  const counts = loadedCounts(files.listings);

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
  const [toolsShown, setToolsShown] = useState(false);
  const [filterFocused, setFilterFocused] = useState(false);

  /**
   * The controls across the top of the column.
   *
   * Sort and collapse are about the *panel* rather than about the context, so
   * neither is gated on `canEdit`: a member reading somebody else's notes has
   * as much use for a folded tree as its owner does.
   *
   * There is no fifth. A "Close the file tree" button used to be drawn under
   * `touch`, and on a pointer layout it would be a fourth way to do what ⌘B
   * and the top bar's toggle already do, on the one density where there is
   * nothing covering the note to dismiss.
   *
   * There was briefly a sixth: a gear that started the one-time storage-layout
   * update. It is gone from here rather than reordered — a maintenance
   * operation somebody runs once, or never, does not earn permanent room
   * beside the four controls they use every day. It lives in Settings →
   * Storage and in a dismissible notice now; see
   * `../storage/StorageMigration.tsx`, which holds the argument and the copy.
   */
  /*
    THE HEADER'S TOOLS, IN TWO GROUPS, AND THE SPLIT IS THE CANVAS'S.

    All four used to arrive together on approach, on the argument that four
    lit buttons over a list of names is the loudest thing in the quietest
    region. That argument was right about *four* and wrong about zero: the
    canvas draws two of them at rest — new note and collapse-all — and a
    header with a name and nothing else reads as a caption rather than as the
    top of a panel you can do things to.

    Which two is not arbitrary. These are the pair with no other route: ⌘N has
    no equivalent for "collapse everything", and both act on the column rather
    than on a row, so neither is in a row's context menu. The pair that fades
    — new folder, and the sort direction — are both reachable from a folder's
    own menu, and sorting is something you set once.
  */
  const restingActions = (
    <>
      {files.canEdit ? (
        <IconButton
          label="New note"
          icon="plus"
          /*
            Makes it, rather than asking what to call it. See `untitled.ts`: the
            note arrives as `untitled-<date>` and takes the first heading typed
            into it.
          */
          onPress={() => files.createUntitled(selectedFolder, "note")}
          testID="explorer-new-note"
        />
      ) : null}
      <IconButton
        label="Collapse every folder"
        icon="collapse"
        onPress={files.collapseAll}
        testID="explorer-collapse"
      />
    </>
  );

  const approachActions = (
    <>
      {files.canEdit ? (
        <IconButton
          label="New folder"
          icon="folder"
          onPress={() => setDialog({ kind: "newFolder", folder: selectedFolder })}
          testID="explorer-new-folder"
        />
      ) : null}
      <IconButton
        label={descending ? "Sort A to Z" : "Sort Z to A"}
        icon="sort"
        onPress={() => setListingOrder(!descending)}
        testID="explorer-sort"
      />
    </>
  );

  /**
   * The filter, permanently in the column's header.
   *
   * No `autoFocus`: this field has always been on the screen, and a permanent
   * field that takes the caret on mount steals it from whatever somebody was
   * doing. It was autofocused under `touch`, where it was a field that had just
   * been *revealed* by a press, and that arm is gone with the density.
   *
   * ## Its box is chrome, so its box arrives on approach
   *
   * The *field* is permanent and stays permanent — it is a real input with a
   * real caret at every moment, and nothing about reaching it changed. What
   * was permanent and should not have been is the 28pt bordered well it was
   * drawn in: at rest it was an empty box at the top of a column whose whole
   * job is to be a quiet list of names, and it was the loudest thing in it —
   * exactly what the four icon buttons beside it were faded for.
   *
   * So at rest it is the word `Filter` in muted type, which reads as the
   * column's label; the border and the fill come in with the buttons. Kept
   * while the query is non-empty, because a field somebody has typed into is
   * not chrome — and while it has focus, so tabbing to it does not land the
   * caret in something that looks like a heading.
   */
  const filterField = (
    <TextInput
      value={query}
      onChangeText={setQuery}
      /*
        Blank until the header is lit, because `Notes` is drawn over the field
        at rest and two words in one box is what a placeholder underneath a
        label looks like. The accessible name is unconditional and on the line
        below, so nothing about reaching this field depends on the word.
      */
      placeholder={toolsShown || filterFocused ? "Filter" : ""}
      placeholderTextColor={colors.muted}
      onFocus={() => setFilterFocused(true)}
      onBlur={() => setFilterFocused(false)}
      style={[
        styles.filter,
        (toolsShown || filterFocused || query !== "") && styles.filterBoxed,
      ]}
      accessibilityLabel="Filter notes and folders"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      testID="explorer-filter"
    />
  );

  return (
    <View
      style={styles.explorer}
      /*
        Chrome on approach.

        Four icon buttons sat lit above the tree at all times. None of them is
        pressed often enough to earn a resting pixel, and together they were
        the loudest thing in a column whose job is to be a quiet list of
        names. They fade in when the pointer enters the column and fade out
        when it leaves.

        Opacity rather than mounting: the buttons keep their box, so the
        toolbar does not reflow under the pointer, keyboard focus still
        reaches them, and the e2e cases that press them by testID still find
        them where they were. `focusable` chrome that vanishes from the tree
        is chrome you cannot tab to.
      */
      onPointerEnter={() => setToolsShown(true)}
      onPointerLeave={() => setToolsShown(false)}
      testID="explorer"
    >
      <View style={styles.toolbar}>
        {/*
          THE COLUMN'S NAME, AT REST, OVER THE FIELD RATHER THAN BESIDE IT.

          The design's tree opens on the word `Notes` — an eyebrow, the way
          every panel in this product labels itself — and the header's controls
          arrive with the pointer. What was here instead was the filter's
          placeholder, which is a different word for a different thing: `Filter`
          answers "what does this box do" and says nothing about what the
          column below it is.

          Drawn *over* the field, absolutely, and faded out as the tools fade
          in — so the field is mounted at every moment, keeps its caret, keeps
          its place in the tab order, and nothing about the row's geometry
          depends on which of the two is visible. `pointerEvents="none"` so the
          label cannot take the press that focuses the field underneath it.

          It goes when the filter has something in it as well as on approach:
          a column showing eight of its forty rows must say why, and `Notes`
          over a filtered tree is a label telling a small lie.
        */}
        <View
          style={[styles.eyebrow, (toolsShown || filterFocused || query !== "") && styles.eyebrowGone]}
          pointerEvents="none"
          aria-hidden
        >
          <Text variant="eyebrow">Notes</Text>
        </View>
        {filterField}
        {query !== "" ? (
          <IconButton
            label="Clear the filter"
            icon="close"
            onPress={closeFilter}
            testID="explorer-filter-clear"
          />
        ) : null}
        <View style={styles.toolbarSpacer} />
        <View style={[styles.tools, toolsShown && styles.toolsShown]}>{approachActions}</View>
        {/*
          Never faded. See `restingActions` — the canvas's header has these two
          at rest, and the fade is now about the pair beside them rather than
          about the whole toolbar.
        */}
        <View style={styles.toolsResting}>{restingActions}</View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        role="tree"
        aria-label="Folders and notes"
        testID="explorer-tree"
      >
        {files.loading ? (
          <Text variant="treeMeta" style={styles.status}>
            Reading your bucket…
          </Text>
        ) : matches !== null ? (
          matches.length === 0 ? (
            <Text variant="treeMeta" style={styles.status}>
              Nothing here matches “{query}”. This filters the tree you have open;
              search {contextLabel} itself from the search box.
            </Text>
          ) : (
            matches.map((match) => (
              <PressRow
                key={match.item.id}
                accessibilityLabel={match.item.label}
                selected={files.selectedPath === match.item.id}
                onPress={() => select(match.item.id)}
                radius={radii.sm}
                style={styles.match}
                hoverStyle={styles.matchHover}
                selectedStyle={styles.matchOn}
              >
                <Text variant="tree" numberOfLines={1}>
                  {match.item.label}
                </Text>
                {match.item.detail ? (
                  <Text variant="treeMeta" numberOfLines={1} style={styles.matchDetail}>
                    {match.item.detail}
                  </Text>
                ) : null}
              </PressRow>
            ))
          )
        ) : (
          <FileTree
            rows={rows}
            canSetVisibility={files.canSetVisibility}
            onSelect={select}
            onToggle={(path) => {
              files.toggleFolder(path);
              files.select(path);
            }}
            onCycleVisibility={(row) => cycleVisibility(files, row)}
            onMenu={openMenu}
            drag={dragHandlers}
            dropTarget={dropTarget}
            pendingStateFor={files.pending?.stateFor}
          />
        )}

        {/*
          The empty space under the last row, as a target rather than as dead
          pixels.

          It is the largest area of this column on any context that does not
          fill the window, and right-clicking it had no answer at all — so the
          browser's menu opened over the file tree, offering Save As and
          Translate to Page on a listing of somebody's notes.

          It is a filler rather than a listener on the scroll view because the
          rows must keep their own gesture: this sits *behind* them and a row's
          handler stops propagation before it ever reaches here. `flexGrow` is
          what makes it the rest of the column rather than a strip; there is no
          minimum, because on a tree that already fills the height there is
          genuinely no background to click.
        */}
        <View style={styles.background} ref={background.ref} collapsable={false} />
      </ScrollView>

      {/*
        The foot: one muted line saying how much of this tree has been read.

        **It used to be three lines and one block — Obsidian's vault switcher —
        and the two lines above this one are gone with the density that had
        them.** The reference (`docs/design/obsidian-parity`, the file-explorer
        shot) ends the sidebar with a row of icon actions, then the vault's name
        with a chevron and a gear, then the count line; a phone drew all three
        because the tree was the whole sheet and its foot was the only place a
        fact about the *context* could sit beside the context's own name.

        A phone has no file tree at all now (`features/app/frame.ts`), so this
        component is a pointer-layout column and nothing else, and the `vault`
        and `vaultDetail` slots had no supplier left. The three facts they
        carried did not go with them: the binding and the tier are the top bar's
        chips here, how much is indexed is the status strip's segment, and on a
        phone all three are the foot of the context's own page — see
        `files/contextFoot.ts` and `FolderView`.

        `loadedCounts` is shared with that page rather than computed here, so
        "how much of this context have I got" has one answer.
      */}
      <View style={styles.foot}>
        <Text variant="treeMeta" numberOfLines={1} testID="explorer-counts">
          {counts}
        </Text>
      </View>

      {/*
        Under the counts rather than over them, and that is the order of the two
        scopes rather than a preference. The counts line is about *this tree*:
        how much of the context you are in has been read. The row below it is
        about which context that is and which others you can reach — a wider
        fact, and the widest fact in a column reads as its footer. Reversed, the
        counts line would sit between two pieces of navigation and read as a
        caption on the workspace above it, which is a sentence about the wrong
        thing.
      */}
      {workspaces}

      {refusal !== null ? (
        <View style={styles.refusal}>
          <Text variant="hint" style={styles.refusalText}>
            {refusal}
          </Text>
          <PressRow
            accessibilityLabel="Dismiss"
            onPress={() => setRefusal(null)}
            radius={radii.sm}
            style={styles.refusalDismiss}
            hoverStyle={styles.matchHover}
          >
            <Icon name="close" size={13} color={colors.warnText} />
          </PressRow>
        </View>
      ) : null}

      {menu !== null ? (
        <Menu
          items={menu.items}
          anchor={menu.anchor}
          title={menu.title}
          onSelect={(id) => {
            const target = menu.target;
            setMenu(null);
            runAction(id, target);
          }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}

      <ExplorerDialogs
        files={files}
        dialog={dialog}
        onClose={() => setDialog(null)}
        access={access}
      />
    </View>
  );
}

interface MenuOpen {
  /**
   * What the menu was opened on, kept whole.
   *
   * It used to be the `TreeRow` alone, which was enough while a row was the
   * only thing in the console that had a menu. The dispatcher now takes a
   * `MenuTarget`, and storing the target rather than re-deriving one on
   * selection is what keeps "what was offered" and "what runs" the same
   * object — a menu built for the background and dispatched against a row is
   * a paste into the wrong folder.
   */
  target: MenuTarget;
  /** For the popover's title. Absent where the target has no single name. */
  title: string;
  anchor: { x: number; y: number };
  items: ReturnType<typeof itemsFor>;
}
type MenuState = MenuOpen | null;

/**
 * Re-exported, not declared. The union moved to `actions.ts`, beside the
 * dispatcher whose output it is; every existing importer of
 * `files/Explorer` keeps working unchanged.
 */
export type { Dialog } from "./actions";

/**
 * The dialogs the tree can raise.
 *
 * Separated so the tree and the editor can drive the same set without either
 * owning it.
 */
export function ExplorerDialogs({
  files,
  dialog,
  onClose,
  access,
  create,
}: {
  files: FileBrowser;
  dialog: Dialog;
  onClose: () => void;
  /**
   * The two rows of the `create` sheet that are not files.
   *
   * Passed in because neither belongs to the file browser: a meeting is the
   * meetings flow's and a conversation is the aside panel's, and this component
   * is mounted by surfaces that have one, both or neither. Absent means the row
   * is not drawn — see `CreatePrompt`.
   */
  create?: {
    onNewMeeting?: (() => void) | null;
    onNewChat?: (() => void) | null;
  };
  /**
   * What the share dialog needs to list who can read a note, and to offer
   * groups as you type.
   *
   * Passed in rather than subscribed here: the console holds one membership
   * and one groups subscription, and a second of either in this component
   * would make every Explorer render test reach for a Convex provider it does
   * not have. Optional, so a caller that has neither draws the dialog without
   * them — which is what it did before this existed.
   */
  access?: {
    members: readonly AccessMember[];
    groups?: readonly RecipientGroup[];
    /**
     * `kind` travels with the path because a folder and a note go to different
     * actions — the note one refuses anything that is not `.md`, which is the
     * refusal an owner met when this dropped it.
     */
    onShareWithGroup?: (path: string, kind: "file" | "folder", group: string) => void;
    /**
     * What a row in the people list can do about somebody, for one path.
     *
     * A factory rather than a handler, because narrowing a note names the
     * note and this component is rendered once for a tree with many. Returns
     * `undefined` for a caller that can do none of it — see `removalHandler`
     * — and the dialog then draws roles rather than controls.
     */
    removalRouteFor?: (
      path: string,
      /** Decides which visibility mutation the narrow route means. */
      kind: "file" | "folder",
    ) => ((route: RemovalRoute, row: AccessRow) => void) | undefined;
    /** The workspace's slug, for showing the name a new group's label becomes. */
    groupSlug?: string;
    /** Whose context this is, so every audience can be named. */
    audience?: AudienceContext;
    /**
     * Make a group and point this path at it. Owner-only upstream.
     *
     * Answers, so the sheet can show a refusal from the control plane where
     * the person can read it — the notice line sits behind the modal.
     */
    onCreateGroup?: (
      path: string,
      /** Same reason `onShareWithGroup` carries one: it ends in the same call. */
      kind: "file" | "folder",
      label: string,
      userIds: readonly string[],
    ) => Promise<unknown>;
  };
}) {
  if (dialog === null) return null;

  switch (dialog.kind) {
    case "create":
      return (
        <CreatePrompt
          folder={dialog.folder}
          canEdit={files.canEdit}
          onCancel={onClose}
          /*
            Neither of these is named. The file is made now, called
            `untitled-<date>`, and takes the first heading typed into it —
            `untitled.ts` has the argument. `CreatePrompt` calls `onCancel`
            before either, so the sheet is gone by the time the editor opens on
            the new note.
          */
          onCreateNote={() => files.createUntitled(dialog.folder, "note")}
          onCreateDrawing={() => files.createUntitled(dialog.folder, "drawing")}
          onCreateFolder={(name) => {
            onClose();
            files.createFolder(dialog.folder, name);
          }}
          onNewMeeting={create?.onNewMeeting ?? null}
          onNewChat={create?.onNewChat ?? null}
        />
      );
    case "newFolder":
      return (
        <NamePrompt
          title="New folder"
          description={NEW_FOLDER_HINT}
          confirmLabel="Create"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.createFolder(dialog.folder, name);
          }}
        />
      );
    case "rename":
      return (
        <NamePrompt
          title="Rename"
          description={sharesBreakingWarning(files.shares, dialog.path, "Renaming") ?? undefined}
          initialValue={baseName(dialog.path)}
          confirmLabel="Rename"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.rename(dialog.path, name);
          }}
        />
      );
    case "move":
      return (
        <MovePicker
          title={`Move ${withoutSortPrefix(baseName(dialog.path))}`}
          description={sharesBreakingWarning(files.shares, dialog.path, "Moving") ?? undefined}
          folders={loadedFolders(files.listings).filter(
            (folder) => dialog.path !== folder && !folder.startsWith(`${dialog.path}/`),
          )}
          currentFolder={parentPath(dialog.path)}
          /*
            Only offered where the browser says so, which is: this person owns
            the context the thing is leaving, and the far end is one they can
            write. Both halves are the server's rule — see
            `functions/contextMoves.ts` — and re-deciding either of them here
            would be a second answer that can drift from the one that is
            actually enforced.

            A folder is not filtered out of the far context's list the way it
            is out of this one, because it cannot be its own ancestor there:
            the two paths are in different buckets.
          */
          destinations={files.moveDestinations}
          loadDestinationFolders={files.destinationFolders}
          onCancel={onClose}
          onConfirm={(folder, contextId) => {
            onClose();
            if (contextId === null) files.move(dialog.path, folder);
            else files.moveToContext(dialog.path, contextId, folder);
          }}
        />
      );
    case "share":
      /*
        Re-checked here rather than trusted from the menu that opened it.
        `canShare` is `canEdit && isOwner`, so it moves independently of
        `canEdit` — the reason `openMenu` lists it in its own dependency array —
        and ownership can go away under a mounted console. A control that is
        present and refused is the defect this codebase records as a live
        breach, not the refusal.
      */
      if (!files.canShare) return null;
      // Braced so the binding below has a block of its own: a `const` bare in
      // a `case` leaks into every sibling arm, which is what
      // `no-case-declarations` is about.
      {
      /*
        Looked up ONCE and used by all four controls below. It was resolved
        inline four times, and one of those four then threw it away on its way
        into `onShareWithGroup` — which is how sharing a folder with a group
        reached the note action and came back "Only markdown notes can have
        their own visibility". One binding is not tidiness here: it is the
        thing that makes dropping it visible.
      */
      const entryKind = findEntry(files.listings, dialog.path)?.kind ?? "file";
      return (
        <ShareDialog
          path={dialog.path}
          shares={files.shares}
          origin={consoleOrigin()}
          onShare={(recipient) => files.share(dialog.path, recipient)}
          onCopyLink={files.copyShareLink}
          onRevoke={(shareId) => files.revokeShare(shareId)}
          onSetPreviewTitle={(share, on) =>
            files.setSharePreviewTitle(dialog.path, share, on)
          }
          // Deliberately does NOT close on share or revoke. Both are things an
          // owner does several of in a row, and a dialog that vanishes after
          // the first one makes them reopen it to check it worked — which is
          // also the moment they share it twice.
          onClose={onClose}
          /*
            The same two things Browse passes. The entry is looked up here
            rather than threaded through `Dialog`, because the listing is the
            authority on what this note currently reads as and the dialog is
            opened from several places.
          */
          access={
            access === undefined
              ? undefined
              : {
                  visibility: findEntry(files.listings, dialog.path)?.visibility ?? "private",
                  exception: findEntry(files.listings, dialog.path)?.exception ?? false,
                  members: access.members,
                }
          }
          groups={access?.groups}
          /*
            The audience control, wired straight from the browser rather than
            threaded through `access`: `setScope` is already the single point
            every surface goes through — its group guard lives there — and this
            component holds `files` anyway. Owner-only, absent otherwise.
          */
          entryKind={entryKind}
          onSetScope={
            files.canSetVisibility
              ? (from, to) =>
                  files.setScope(dialog.path, entryKind, from, to)
              : undefined
          }
          onRemovalRoute={access?.removalRouteFor?.(dialog.path, entryKind)}
          groupSlug={access?.groupSlug}
          context={access?.audience}
          onCreateGroup={
            access?.onCreateGroup === undefined
              ? undefined
              : (label, userIds) =>
                  access.onCreateGroup!(dialog.path, entryKind, label, userIds)
          }
          onShareWithGroup={
            access?.onShareWithGroup === undefined
              ? undefined
              : (group) => access.onShareWithGroup!(dialog.path, entryKind, group)
          }
        />
      );
      }
    case "archive":
      return (
        /*
          "Nothing is deleted" is true of the bytes and was false of the
          access: a share is stored against the path, so archiving takes every
          outstanding link with it. The sentence is appended rather than
          replacing the reassurance, because both are true and the reassurance
          is the one people came for.
        */
        <Confirm
          title="Archive"
          body={[
            `${dialog.path} moves into 4-archive/ with its original path kept inside, so you can move it straight back. Nothing is deleted.`,
            sharesBreakingWarning(files.shares, dialog.path, "Archiving"),
          ]
            .filter(Boolean)
            .join(" ")}
          confirmLabel="Archive it"
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.archive(dialog.path);
          }}
        />
      );
  }
}

function IconButton({
  label,
  icon,
  onPress,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={onPress}
      radius={radii.md}
      style={styles.iconButton}
      hoverStyle={styles.iconButtonHover}
      testID={testID}
    >
      <Icon name={icon} size={15} color={colors.text2} />
    </PressRow>
  );
}

/** The inline control: private ↔ team, through the privacy manifest. */
function cycleVisibility(files: FileBrowser, row: TreeRow): void {
  if (row.readOnly) return;
  const current = row.marker ?? inheritedOf(files, row.path);
  // There is no next position to cycle to from a group rule, and the one this
  // would have picked is `team` — the single press that publishes it.
  // `setVisibility` refuses this too; returning here keeps the control from
  // producing a notice for a press that could never have been meaningful.
  if (isGroupVisibility(current)) return;
  files.setVisibility(
    row.path,
    row.kind === "folder" ? "folder" : "file",
    current === "team" ? "private" : "team",
  );
}

function inheritedOf(files: FileBrowser, path: string): Visibility {
  for (const listing of Object.values(files.listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.path === path) return entry.inherited;
    }
  }
  return "private";
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  explorer: { flex: 1, minHeight: 0 },

  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.x2,
    paddingVertical: space.x2,
  },
  /**
   * Holds the create buttons at the trailing edge while the filter is away.
   *
   * The field is `flex: 1` and takes the room when it is there; without this
   * the row would close up and `+` would sit at the leading edge in one state
   * and the trailing edge in the other — a target that moves when a control
   * beside it is revealed.
   */
  toolbarSpacer: { flexGrow: 1, flexShrink: 1 },
  /* See the column's `onPointerEnter`: present, laid out, and unlit at rest. */
  tools: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    opacity: 0,
  },
  toolsShown: { opacity: 1 },
  /** The pair the canvas draws at rest. Same row, no fade. */
  toolsResting: { flexDirection: "row", alignItems: "center" },
  /**
   * The resting label, in the field's own box.
   *
   * Absolute and inset to the field's horizontal padding, so the word starts
   * at exactly the character the placeholder would have — the two swap without
   * anything moving. `justifyContent: "center"` because the box is 28pt and
   * the label is one line of 11pt type.
   */
  eyebrow: {
    position: "absolute",
    left: space.x2 + space.x2,
    top: space.x2,
    height: 28,
    justifyContent: "center",
  },
  eyebrowGone: { opacity: 0 },
  /**
   * At rest: type, in the header's own gutter, with no box at all.
   *
   * The border is `transparent` rather than absent so the field does not
   * change size when it gains one — a header that grew 2pt as the pointer
   * crossed the column would be a layout jumping under the hand reaching for
   * it, which is the failure `tools` fades opacity to avoid.
   */
  filter: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: space.x2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
    color: colors.text,
    fontSize: t.meta,
  },
  /** On approach, on focus, or once somebody has typed. */
  filterBoxed: { borderColor: colors.line, backgroundColor: colors.well },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  iconButtonHover: { borderColor: colors.lineStrong },

  scroll: { flex: 1, minHeight: 0 },
  /**
   * `flexGrow` so the background filler below the rows can take the rest of
   * the column. Without it the content container is exactly as tall as its
   * rows and the filler is zero-height — which is a right-click target that
   * exists in the tree and not on the screen.
   */
  scrollContent: { paddingVertical: space.x2, paddingHorizontal: 6, flexGrow: 1 },
  /** See the filler's own comment in the render. */
  background: { flexGrow: 1 },
  status: { paddingHorizontal: space.x2, paddingVertical: space.x2 },

  match: {
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 1,
    width: "100%",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
  },
  matchHover: { backgroundColor: colors.surface3 },
  matchOn: { backgroundColor: colors.accentDim },
  matchDetail: { opacity: 0.85 },

  refusal: {
    marginHorizontal: space.x2,
    marginBottom: space.x2,
    paddingVertical: space.x2,
    paddingHorizontal: space.x3,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnWash,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.x2,
  },
  refusalText: { flex: 1, color: colors.warnText },
  refusalDismiss: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.sm },

  /** A 26pt strip under the column, carrying the one counts line. */
  foot: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: space.x3,
    paddingVertical: 5,
    gap: space.x2,
  },
});
