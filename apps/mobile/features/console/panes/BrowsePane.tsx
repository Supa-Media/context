import { useState } from "react";
import { View } from "react-native";
import { useConsoleNav } from "../ConsoleNavContext";
import { useSurfacePadding } from "../../app/Screen";
import { useThemedStyles } from "../../design/theme";
import { Menu } from "../../design/components/Menu";
import { runMenuAction } from "../files/actions";
import { ExplorerDialogs } from "../files/Explorer";
import { useReadMode } from "../files/readMode";
import { useDeclaredView } from "../files/viewMode";
import { entryAt } from "../files/tree";
import { atName } from "../format";
import { selectedContext } from "../types";
import { classifyCommsPath } from "../communications/paths";
import { BrowseDocument } from "./browsePane/BrowseDocument";
import { BrowseNoteHead } from "./browsePane/BrowseNoteHead";
import { BrowseNotices } from "./browsePane/BrowseNotices";
import { BrowsePathBar } from "./browsePane/BrowsePathBar";
import { BrowseShareDialog } from "./browsePane/BrowseShareDialog";
import { DocumentSurface } from "./browsePane/DocumentSurface";
import type { BrowsePaneProps } from "./browsePane/props";
import { makeStyles } from "./browsePane/styles";
import { useBrowseNotices } from "./browsePane/useBrowseNotices";
import { useFolderListing } from "./browsePane/useFolderListing";

/**
 * Browse — the note, and nothing between you and it.
 *
 * The tab strip is *not* here. It is chrome belonging to the editor region, so
 * the layout draws it above this pane — which also keeps one tab state in the
 * app rather than one per pane that mounts.
 *
 * ## What this pane used to be
 *
 * The whole file editor: a 246px tree beside the note, a "New note / New
 * folder" toolbar above the tree, a pane heading with a paragraph explaining
 * what markdown is, and — above every document — a card header carrying the
 * file name, two chips and a byte count, and beneath *that* a row of seven
 * buttons: Rename, Move, Duplicate, Copy, Cut, Archive, Delete…
 *
 * All of it is gone, and every operation still exists. The tree became a region
 * of the frame (`files/Explorer.tsx`); the buttons became the row's own
 * right-click menu and long-press sheet; the card header became a one-line
 * breadcrumb at the top of the region.
 *
 * On a phone even that line has gone, because Obsidian spends nothing on it:
 * the note names itself with an inline title inside the document, its
 * visibility is a Properties row, and Share is in the top bar's trailing
 * group. What is left at that density is one full-bleed scroll surface with
 * the document on it and the chrome floating over both ends. A pointer layout
 * keeps the tab strip and the breadcrumb — there the line is a region header
 * that also carries folder navigation, which an inline title cannot.
 *
 * ## Why the note is no longer in a card
 *
 * A bordered, rounded, inset card is right for a *widget on a page* and wrong
 * for the primary surface of an application. It cost 16px of padding, a border
 * and a radius on all four sides of the thing people actually came to read, and
 * it drew a boundary around the one element that should extend to the edges of
 * its region. The editor now fills what it is given.
 */
export function BrowsePane({
  data,
  presence,
  drawingCollaboration,
  /**
   * Opens this context's settings. Absent where there is nowhere to go, and the
   * control is then not rendered rather than rendered dead.
   */
  onOpenSettings,
  pendingNote,
  anchor,
  onOpenComms,
  onNavigate,
}: BrowsePaneProps) {
  const styles = useThemedStyles(makeStyles);
  const files = data.files;
  // Following a link, and the breadcrumb's `‹ ›`. `null` outside a console
  // layout — the landing page's demo pane — see `ConsoleNavContext`.
  const nav = useConsoleNav();
  const current = selectedContext(data);
  const contextLabel = atName(current?.slug ?? "your context");

  /*
    `entryAt`, not `findEntry`: a folder reached by a link, a restored tab or a
    reload with the tree collapsed has no parent listing to be found in, and
    this pane used to answer that with its "choose a note" empty state — over a
    folder whose contents had already arrived. See `entryAt`.
  */
  const selected =
    files.selectedPath === null
      ? null
      : entryAt(files.listings, files.selectedPath, files.editor);

  /**
   * Whether the file browser is talking about the context the console is on.
   *
   * They differ for the commits between pressing another context and the
   * browser resetting under it — the same lag `noteAddress.ts` waits out, from
   * the other end. Everything else in this pane is drawn from the browser's own
   * state and is therefore internally consistent while that happens; the
   * **breadcrumb is not**, because its head is `CurrentContextPill`, which is
   * built from the console's selection and moves first.
   *
   * So for those commits the band would read `@supa / 1-projects / a-note-in-seyi`
   * — one context's pill over another context's path, which is a sentence that
   * has never been true. Nothing rather than a stale path: the pill alone is
   * honest, it is where the switch is going, and the path arrives with the
   * listing a moment later.
   *
   * **The pointer layout's region header gets the same guard**, because it has
   * the same seam for the same reason: its leading segment is `contextLabel`,
   * which comes from the console, over folders that come from the browser. It
   * takes the note's action row with it, which is right rather than incidental
   * — Share and the scope lock act on the open note, and for those commits the
   * open note belongs to the context being left.
   */
  const settled = files.contextId === data.selectedContextId;

  /**
   * The note the share dialog is open for, or `null`.
   *
   * Held here rather than lifted into `Explorer`'s dialog union: that state
   * belongs to the *tree*, and this is the editor region. Two entry points to
   * one dialog is not two dialogs — `ShareDialog` holds nothing of its own
   * beyond a draft recipient.
   */
  /*
    Reading mode, from the bus the layout's eye writes to. `NoteEditor` takes
    it as a prop and reaches for nothing itself — see the comment on `reading`
    there, and `files/readMode.ts` for why this is a bus and not the route.
  */
  const reading = useReadMode();
  /*
    …and the other half of it: what the note itself asked for. A page built
    around a `form` fence is only usable while it is read, so its author can say
    so in the frontmatter and everybody who opens it lands on the form rather
    than on the code fence that draws it. `files/viewMode.ts` holds the reader,
    the vocabulary and the rule that the person's own press outranks the file.

    The identity passed is the **context and the path together**: this pane is
    reconciled with no `key` across a context switch (see the share dialog
    below), so two contexts' `1-projects/plan.md` are one string apart, and
    under PARA conventions that is a collision waiting rather than a hypothesis.
    `editor.path` moves only when a body arrives with it — `useFileBrowser`
    dispatches `opened` with the note — so there is no frame in which this is
    asked about a note whose text has not landed.
  */
  useDeclaredView(
    files.editor.path === null ? null : `${files.contextId ?? ""}:${files.editor.path}`,
    files.editor.draft,
    files.editor.path,
  );
  const [sharing, setSharing] = useState<string | null>(null);
  /**
   * How wide the note's column is, so the breadcrumb can start where its text
   * does.
   *
   * Measured rather than derived from the window: this row is inside the
   * editor region, and how much of the window that region gets depends on the
   * explorer's width, which somebody drags. `0` until the first layout, which
   * `noteGutterFor` floors to the plain gutter — the same answer as a window
   * too narrow for the measure, so the first frame is never wrong in a
   * direction anybody sees.
   */
  const [headWidth, setHeadWidth] = useState(0);

  const {
    folderMenu,
    setFolderMenu,
    folderDialog,
    setFolderDialog,
    encryption: {
      noteEncryption,
      announceNoteLock,
      lockBusy,
      setLockBusy,
      lockError,
      setLockError,
    },
    compact,
    menuActions,
    openCrumbMenu,
    folderMenuFor,
    folderDrag,
  } = useFolderListing({ files, contextLabel, settled, current, data });
  /*
    The two bands the floating chrome occupies, spent as content padding at
    both ends.

    Nothing in this region is pushed clear of the chrome any more. The region
    runs full-bleed from the top of the glass to the bottom, the bars lie over
    it, and the scroller inside pays for them in `contentContainerStyle` — so
    the first line and the last can both be scrolled out from under, and
    everything in between passes behind. That is the whole of what
    `FrameApi.contentInsets` is for, and until this change only the bottom half
    of it was being used: the top band carried a breadcrumb, so the region was
    padded down past the chrome and the note began underneath it.
  */
  const padding = useSurfacePadding();

  const {
    noBucket,
    manifestBroken,
    setup,
    writing,
    storageMigration,
    intro,
    introAnswer,
    introVisible,
    setDismissedMoves,
    moveNotices,
    hasNotice,
  } = useBrowseNotices({ data, files, current, compact });

  /**
   * What this pane has to say about the note, above it.
   *
   * A node rather than inline JSX because on a phone it belongs **inside** the
   * scroll surface — it is part of the document's flow, not a band pinned above
   * it — and the scroller a note lives in belongs to `NoteEditor` (see the
   * `notices` prop there and `NoteAccessory` for why). A pointer layout keeps
   * it where it was, above a region that scrolls itself.
   */
  const notices = !hasNotice ? null : (
    <BrowseNotices
      data={data}
      files={files}
      current={current}
      compact={compact}
      onOpenSettings={onOpenSettings}
      onNavigate={onNavigate}
      setup={setup}
      writing={writing}
      introVisible={introVisible}
      intro={intro}
      introAnswer={introAnswer}
      noBucket={noBucket}
      manifestBroken={manifestBroken}
      moveNotices={moveNotices}
      setDismissedMoves={setDismissedMoves}
      storageMigration={storageMigration}
    />
  );

  /**
   * The three things that can be in front of somebody, built once.
   *
   * They are placed differently at the two densities — a phone scrolls a folder
   * listing as a page and hands a note its own scroller — and building them
   * here rather than in each branch is what stops the two placements drifting
   * into two sets of props.
   */
  /** See `BrowsePathBar`: where you are, and the way up — the phone's answer to both. */
  const pathBar = compact ? (
    <BrowsePathBar
      files={files}
      selected={selected}
      settled={settled}
      openCrumbMenu={openCrumbMenu}
    />
  ) : null;

  /**
   * What a selected path is, for the communications console — or `null` when
   * it is an ordinary note or folder. Computed once and read three times
   * below rather than three separate calls, so all three branches agree with
   * each other by construction.
   */
  const commsRoute = selected === null ? null : classifyCommsPath(selected.path);

  const handleOpenComms =
    onOpenComms ??
    ((path: string) => {
      files.select(path);
    });

  const openDocument = (
    <BrowseDocument
      data={data}
      files={files}
      current={current}
      selected={selected}
      settled={settled}
      compact={compact}
      contextLabel={contextLabel}
      pendingNote={pendingNote}
      anchor={anchor}
      presence={presence}
      drawingCollaboration={drawingCollaboration}
      reading={reading}
      nav={nav}
      commsRoute={commsRoute}
      handleOpenComms={handleOpenComms}
      folderMenuFor={folderMenuFor}
      folderDrag={folderDrag}
      noteEncryption={noteEncryption}
      notices={notices}
      pathBar={pathBar}
    />
  );

  return (
    <View style={styles.region}>
      {/*
        The breadcrumb is drawn for a selected *folder* too, not only a note —
        **and only on a pointer layout.**

        It used to be `kind === "file"` only, and `FolderView` prints the
        folder's own name with no path — so two folders called `notes` were the
        same screen, and there was nowhere that said which one you were in. That
        matters beyond orientation: the toolbar's `+` writes into the selected
        folder, and this line is what names it.

        ## Why a phone has none

        Obsidian on iOS has no breadcrumb, and that is not an omission: the note
        names itself with an inline title at the top of its own text, and a full
        path pinned *above* the document is a second band of chrome under a bar
        that is already floating there — the two rows this branch exists to
        collapse into one — costing the note its first screen.

        So at `compact` the three things this row carried have each gone
        somewhere they belong rather than being deleted: the note's name is the
        inline title inside the document (`NoteEditor`), the visibility chip is
        a Properties row (also `NoteEditor` — `visibility:` is filing metadata),
        and Share is in the top bar's trailing group (`_layout`, where Obsidian
        puts the ⋯ container).

        **The fourth thing it carried was folder navigation, and this used to
        hand that to "the tree", which a phone no longer has.** It is `pathBar`
        below — the same `Breadcrumb` in `pathOnly` mode, drawn *inside* the
        note rather than pinned over it, so it scrolls away with the document —
        plus `FolderView`, which is what a segment of it opens. That is not the
        row this branch removed: it is one line of monospace path with no title,
        no chip and no Share on it, and it is the only way up on a density with
        no panel.
      */}
      {selected !== null && settled && !compact ? (
        <BrowseNoteHead
          files={files}
          selected={selected}
          nav={nav}
          reading={reading}
          headWidth={headWidth}
          setHeadWidth={setHeadWidth}
          setSharing={setSharing}
          openCrumbMenu={openCrumbMenu}
        />
      ) : null}

      {/*
        The dialog is pinned to the note it names, and to the capability that
        opened it, because neither of those holds still while it is on screen.

        `<Slot/>` in `app/(app)/console/_layout.tsx` reconciles this pane by
        component type with **no `key`**, so `sharing` survives
        `/console/@a` → `/console/@b` — the same mechanism `Explorer.tsx`
        documents for its own callbacks. Left unchecked, the dialog stayed open
        across a context switch still titled after the old context's note, and
        submitting called the *new* context's `share` with the *old* context's
        path. `createShare` checks `requireWorkspaceRole(owner)` and the path's
        syntax, never that the path exists in that workspace — so under PARA
        conventions, where `1-projects/plan.md` plausibly exists in both, the
        owner grants a recipient read access to a note they did not aim at.

        `files.canShare` is re-checked for the reason the button reads it
        inline: it is `canEdit && isOwner`, so it moves independently, and this
        codebase treats a control that is present and refused as the defect
        rather than the refusal.

        It closes the keyboard route as a side effect, and that is worth
        knowing rather than rediscovering. `BrowsePane` reports no
        `onOverlayChange`, so `scopeForFocus` answers `global` with this dialog
        open and every GLOBAL binding in `keymap.ts` still fires behind it —
        ⌘K can change the selection under the dialog. Pinned to the selection,
        the dialog closes rather than acting on a stale path. The missing
        overlay channel is filed separately; this is not a substitute for it.

        `!selected.readOnly` is an **equivalent mutant** today and is kept
        anyway: dropping it fails nothing, because the button that sets
        `sharing` already requires it and `readOnly` is `key === PRIVACY_KEY`,
        so a note cannot acquire it while staying the selected one. It mirrors
        the button rather than reasoning from what `readOnly` happens to mean,
        and it stops being equivalent the day anything else is read-only. Said
        plainly because "sabotaging it fails nothing" is otherwise indis-
        tinguishable from an untested guard, which is what this file's
        neighbours keep turning out to be.
      */}
      {sharing !== null && files.canShare && selected?.path === sharing && !selected.readOnly ? (
        <BrowseShareDialog
          data={data}
          files={files}
          current={current}
          selected={selected}
          sharing={sharing}
          setSharing={setSharing}
          onOpenSettings={onOpenSettings}
          noteEncryption={noteEncryption}
          announceNoteLock={announceNoteLock}
          lockBusy={lockBusy}
          setLockBusy={setLockBusy}
          lockError={lockError}
          setLockError={setLockError}
        />
      ) : null}

      <DocumentSurface
        selected={selected}
        compact={compact}
        commsRoute={commsRoute}
        padding={padding}
        openDocument={openDocument}
        notices={notices}
        pathBar={pathBar}
      />

      {/*
        The listing's menu and the questions it leads to.

        At the end of the region rather than inside the scroller: the popover is
        positioned against the viewport (`Menu.web.tsx` measures and flips), so
        a parent that scrolls would carry it away from the pointer.

        A second `ExplorerDialogs` beside the console layout's own is the
        established shape here rather than a smell — `Explorer` renders one for
        the tree's `+` and the layout renders one for the toolbar's, each
        driven by its own state, because a dialog belongs to the surface that
        raised it.
      */}
      {folderMenu !== null ? (
        <Menu
          items={folderMenu.items}
          anchor={folderMenu.anchor}
          title={folderMenu.title}
          onSelect={(id) => {
            const target = folderMenu.target;
            setFolderMenu(null);
            runMenuAction(id, target, menuActions);
          }}
          onDismiss={() => setFolderMenu(null)}
        />
      ) : null}

      <ExplorerDialogs
        files={files}
        dialog={folderDialog}
        onClose={() => setFolderDialog(null)}
      />
    </View>
  );
}
