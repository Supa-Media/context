import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon, type IconName } from "../../design/components/Icon";
import { Menu } from "../../design/components/Menu";
import { Text } from "../../design/components/Text";
import { writeClipboard } from "../../design/clipboard";
import { isApplePlatform } from "../../design/applePlatform";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFrame } from "../../app/AppFrame";
import { loadedFolders, type FileBrowser } from "./browser";
import { loadedCounts } from "./contextFoot";
import { Confirm, DeleteForever, MovePicker, NamePrompt } from "./Dialogs";
import { ShareDialog } from "./ShareDialog";
import { consoleOrigin } from "./shareOrigin";
import { sharesBreakingWarning } from "./shares";
import { canDrop as verdictFor, type DragSource } from "./dnd";
import { FileTree, type TreeDragHandlers } from "./FileTree";
import { itemsFor, type MenuActionId } from "./menu";
import { baseName, parentPath, restoreTargetFor } from "./paths";
import { itemsFromListings, rank } from "./palette";
import { buildTreeRows, findEntry, targetFolder, type TreeRow } from "./tree";
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
}: {
  files: FileBrowser;
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
  const [descending, setDescending] = useState(false);
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
   * `closesOnSelect` is `false` at every density today — there is no drawer
   * anywhere (`features/app/frame.ts`) — so the second line does nothing. It is
   * kept rather than inlined to `files.select` because that file's header names
   * this call site: `closesOnSelect` and `closeDrawer` are `AppFrame`'s API,
   * the meaning lives in one function, and the day a density puts the tree over
   * the document again it is `closesOnSelect` that changes and not this.
   *
   * `useCallback` because `runAction` depends on it: a plain arrow is a new
   * identity every render, which would rebuild that callback on every keystroke
   * in the filter box.
   */
  const select = useCallback(
    (path: string) => {
      files.select(path);
      if (frame.closesOnSelect) frame.closeDrawer();
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

  const openMenu = useCallback(
    (row: TreeRow, anchor: { x: number; y: number }) => {
      const items = itemsFor({
        target: { kind: "row", row },
        canEdit: files.canEdit,
        canSetVisibility: files.canSetVisibility,
        canShare: files.canShare,
        clipboard: files.clipboard,
        platform,
        // Read, never assumed. `menu.ts` defaults this to Apple, which prints
        // `⌘⇧M` on Windows beside a row whose chord is actually `Ctrl+Shift+M`.
        apple: isApplePlatform(),
      });
      // An empty menu is not an empty menu — it is no menu. Opening a bordered
      // rectangle with nothing in it reads as a bug.
      if (items.length === 0) return;
      setMenu({ row, anchor, items });
    },
    // `files.canSetVisibility` is read above and belongs here. It is
    // `canEdit && isOwner`, so it moves independently of the other three — and
    // `<Explorer>` is mounted without a `key` in a layout that survives a
    // context switch, so owning one context and editing the next keeps
    // `canEdit` true while ownership goes away. Left out, this callback kept
    // the first context's ownership and offered the owner-only submenu to
    // somebody the server refuses. eslint reported it as a warning throughout;
    // `lint` exits 0 on warnings.
    // `files.canShare` belongs here for exactly the reason `canSetVisibility`
    // does, one paragraph up: it is `canEdit && isOwner`, so it moves
    // independently of `canEdit`, and a stale copy offers an owner-only control
    // to somebody the server refuses. `explorerMenuStaleGate.test.ts` is what
    // holds both.
    [files.canEdit, files.canSetVisibility, files.canShare, files.clipboard, platform],
  );

  const runAction = useCallback(
    (id: MenuActionId, row: TreeRow) => {
      const path = row.path;
      const folder = row.kind === "folder" ? path : parentPath(path);
      const kind = row.kind === "folder" ? ("folder" as const) : ("file" as const);

      switch (id) {
        case "open":
          select(path);
          return;
        case "openInNewTab":
          // A plain open leaves a preview tab that the next click replaces;
          // this is the one that keeps it. Falls back to a plain open where
          // there are no tabs rather than doing nothing.
          if (onOpenPinned !== undefined) onOpenPinned(path);
          else select(path);
          return;
        case "newNote":
          setDialog({ kind: "newNote", folder });
          return;
        case "newFolder":
          setDialog({ kind: "newFolder", folder });
          return;
        case "rename":
          setDialog({ kind: "rename", path });
          return;
        case "moveTo":
          setDialog({ kind: "move", path });
          return;
        case "archive":
          setDialog({ kind: "archive", path });
          return;
        case "delete":
          setDialog({ kind: "delete", path, isFolder: row.kind === "folder" });
          return;
        case "share":
          setDialog({ kind: "share", path });
          return;
        case "duplicate":
          files.duplicate(path);
          return;
        case "copy":
          files.copy(path);
          return;
        case "cut":
          files.cut(path);
          return;
        case "paste":
          files.paste(folder);
          return;
        case "restore": {
          // `paths.ts` owns the archive-path arithmetic; `menu.ts` uses the
          // same function to decide whether to offer this at all, so the two
          // cannot disagree about what is restorable.
          const original = restoreTargetFor(path);
          if (original !== null) files.move(path, parentPath(original));
          return;
        }
        case "copyPath":
          void writeClipboard(path);
          return;
        case "copyAtPath":
          // The product's addressable form. Dragging a note out of the app
          // produces the same string, so the two ways of taking a reference
          // agree.
          void writeClipboard(`${contextLabel}/${path}`);
          return;
        case "visibilityPrivate":
          files.setVisibility(path, kind, "private");
          return;
        case "visibilityTeam":
          files.setVisibility(path, kind, "team");
          return;
        case "visibilityFollow":
          // Setting a note to its folder's default *removes* the exception
          // rather than writing a redundant line — see `setVisibility` in
          // `functions/lib/fileOps.ts`. So "follow folder" is expressible with
          // the interface as it stands, and there is nothing to add.
          files.setVisibility(path, kind, inheritedOf(files, path));
          return;
        case "visibility":
          // The submenu's parent. It opens a submenu and dispatches nothing;
          // firing an id here would set a visibility nobody asked for.
          return;
      }
    },
    [files, contextLabel, select, onOpenPinned],
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

  /**
   * The four controls, across the top of the column.
   *
   * Sort and collapse are about the *panel* rather than about the context, so
   * neither is gated on `canEdit`: a member reading somebody else's notes has
   * as much use for a folded tree as its owner does.
   *
   * There is no fifth. A "Close the file tree" button used to be drawn under
   * `touch`, and on a pointer layout it would be a fourth way to do what ⌘⇧E
   * and the top bar's toggle already do, on the one density where there is
   * nothing covering the note to dismiss.
   */
  const actions = (
    <>
      {files.canEdit ? (
        <>
          <IconButton
            label="New note"
            icon="plus"
            onPress={() => setDialog({ kind: "newNote", folder: selectedFolder })}
            testID="explorer-new-note"
          />
          <IconButton
            label="New folder"
            icon="folder"
            onPress={() => setDialog({ kind: "newFolder", folder: selectedFolder })}
            testID="explorer-new-folder"
          />
        </>
      ) : null}
      <IconButton
        label={descending ? "Sort A to Z" : "Sort Z to A"}
        icon="sort"
        onPress={() => setDescending((current) => !current)}
        testID="explorer-sort"
      />
      <IconButton
        label="Collapse every folder"
        icon="collapse"
        onPress={files.collapseAll}
        testID="explorer-collapse"
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
   */
  const filterField = (
    <TextInput
      value={query}
      onChangeText={setQuery}
      placeholder="Filter"
      placeholderTextColor={colors.muted}
      style={styles.filter}
      accessibilityLabel="Filter notes and folders"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      testID="explorer-filter"
    />
  );

  return (
    <View style={styles.explorer}>
      <View style={styles.toolbar}>
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
        {actions}
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
          />
        )}
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
          title={baseName(menu.row.path)}
          onSelect={(id) => {
            const row = menu.row;
            setMenu(null);
            runAction(id, row);
          }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}

      <ExplorerDialogs files={files} dialog={dialog} onClose={() => setDialog(null)} />
    </View>
  );
}

interface MenuOpen {
  row: TreeRow;
  anchor: { x: number; y: number };
  items: ReturnType<typeof itemsFor>;
}
type MenuState = MenuOpen | null;

export type Dialog =
  | { kind: "newNote"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; isFolder: boolean }
  | { kind: "share"; path: string }
  | null;

/**
 * The dialogs the tree can raise.
 *
 * Separated so the tree and the editor can drive the same set without either
 * owning it — and so the one dialog that must never become a boolean on
 * another, `DeleteForever`, stays visibly its own thing.
 */
export function ExplorerDialogs({
  files,
  dialog,
  onClose,
}: {
  files: FileBrowser;
  dialog: Dialog;
  onClose: () => void;
}) {
  if (dialog === null) return null;

  switch (dialog.kind) {
    case "newNote":
      return (
        <NamePrompt
          title="New note"
          description={`It will be created in ${dialog.folder || "the root of your context"} as markdown.`}
          confirmLabel="Create"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.createNote(dialog.folder, name);
          }}
        />
      );
    case "newFolder":
      return (
        <NamePrompt
          title="New folder"
          description="A bucket has no empty folders, so this also writes a README.md inside it — visible in Obsidian and to every other tool that reads your bucket."
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
          title={`Move ${baseName(dialog.path)}`}
          description={sharesBreakingWarning(files.shares, dialog.path, "Moving") ?? undefined}
          folders={loadedFolders(files.listings).filter(
            (folder) => dialog.path !== folder && !folder.startsWith(`${dialog.path}/`),
          )}
          currentFolder={parentPath(dialog.path)}
          onCancel={onClose}
          onConfirm={(folder) => {
            onClose();
            files.move(dialog.path, folder);
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
        />
      );
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
    case "delete":
      return (
        <DeleteForever
          path={dialog.path}
          isFolder={dialog.isFolder}
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.destroy(dialog.path);
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
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
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
  filter: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: space.x2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    color: colors.text,
    fontSize: 12,
  },
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
  scrollContent: { paddingVertical: space.x2, paddingHorizontal: 6 },
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
