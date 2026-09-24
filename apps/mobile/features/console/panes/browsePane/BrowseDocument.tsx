import type { ReactNode } from "react";
import type { useConsoleNav } from "../../ConsoleNavContext";
import { contextFootLine } from "../../files/contextFoot";
import type { FileBrowser } from "../../files/browser";
import { ConflictResolver } from "../../files/ConflictResolver";
import { FolderView } from "../../files/FolderView";
import { NoteEditor } from "../../files/NoteEditor";
import { entryAt } from "../../files/tree";
import { useFolderLists } from "../../../offline/useFolderLists";
import { canEditActivity, capabilitiesForRole } from "../../capabilities";
import type { ConsoleData, selectedContext } from "../../types";
import { ChannelDayView } from "../../communications/ChannelDayView";
import { ChannelView } from "../../communications/ChannelView";
import { ContactPageView } from "../../communications/ContactPageView";
import { InboxView } from "../../communications/InboxView";
import { MAIL_CONNECT_ENABLED } from "../../communications/flags";
import type { classifyCommsPath } from "../../communications/paths";
import { Empty } from "./Empty";
import type { BrowsePaneProps } from "./props";
import type { BrowseEncryption } from "./useBrowseEncryption";
import type { FolderListingState } from "./useFolderListing";

/**
 * Whatever is in front of somebody: the empty state or the phone's landing
 * page, a communications view, a folder, a conflict, or the note. Where it is
 * placed — and in which scroller — is `DocumentSurface`'s.
 */
export function BrowseDocument({
  data,
  files,
  current,
  selected,
  settled,
  compact,
  contextLabel,
  pendingNote,
  anchor,
  presence,
  drawingCollaboration,
  reading,
  nav,
  commsRoute,
  handleOpenComms,
  folderMenuFor,
  folderDrag,
  noteEncryption,
  notices,
  pathBar,
}: {
  data: ConsoleData;
  files: FileBrowser;
  current: ReturnType<typeof selectedContext>;
  selected: ReturnType<typeof entryAt>;
  settled: boolean;
  compact: boolean;
  contextLabel: string;
  pendingNote: BrowsePaneProps["pendingNote"];
  anchor: BrowsePaneProps["anchor"];
  presence: BrowsePaneProps["presence"];
  drawingCollaboration: BrowsePaneProps["drawingCollaboration"];
  reading: boolean;
  nav: ReturnType<typeof useConsoleNav>;
  commsRoute: ReturnType<typeof classifyCommsPath> | null;
  handleOpenComms: (path: string, anchor?: string) => void;
  folderMenuFor: FolderListingState["folderMenuFor"];
  folderDrag: FolderListingState["folderDrag"];
  noteEncryption: BrowseEncryption["noteEncryption"];
  notices: ReactNode;
  pathBar: ReactNode;
}) {
  // Where a folder list in the open note reads its notes: this device's copy.
  const folderLists = useFolderLists(current?.id, current?.role);
  /**
   * Where a phone starts, when nothing has been opened yet.
   *
   * `Empty` says "choose a note … right-click any row", which was true while
   * the tree was a drawer one press away. There are no rows on a phone now
   * until you are standing in a folder, so that sentence named a gesture with
   * nothing to perform it on and the pane was a dead end: `/console/@seyi` with
   * no `?note=` had no route to a single note in the context.
   *
   * The context's root folder *is* the context, so it is the page. This is a
   * render fallback and deliberately **not** a `select("")` — a selection
   * written here would be a third writer of the thing `useNoteAddress` owns
   * two directions of, and `noteAddress.ts` exists because that relationship
   * oscillates when more than one thing drives it.
   *
   * `null` before the root's listing has arrived, and the pane then draws
   * nothing rather than the empty state: a bucket that has not answered is not
   * a context with nothing in it, which is the rule `ConsoleData.storage` needs
   * three values for one layer up. A pointer layout keeps `Empty`, where
   * "choose a note" names a tree that is on the screen.
   */
  const landing = compact ? entryAt(files.listings, "") : null;

  /**
   * Whether what is about to be drawn is the context's own page.
   *
   * One expression rather than a check at each of the two `FolderView`s: they
   * are the same page reached two ways — selected, or landed on — and two
   * copies of "is this the root" is how a caption ends up on one and not the
   * other.
   */
  const atContextRoot = compact && (selected === null ? landing !== null : selected.path === "");

  /**
   * `R2 · notes-bucket · 62% indexed · 12 notes, 8 folders`, for the context's own
   * page.
   *
   * **This line lost its home and is being given one.** It was the file tree's
   * footer, and it was on a phone *because* a phone has no status strip — at
   * `compact` the frame draws a bottom toolbar and no status bar
   * (`features/app/frame.ts`), so without it the only way to learn how far a
   * backfill had got was to open settings, which is the state that made a stuck
   * backfill and a working one look identical for hours. A phone has no file
   * tree at all now, so the line went with the tree and the phone lost the
   * feature outright; nothing about the reason it existed changed.
   *
   * The foot of the context root page is where it lands, and `FolderView`'s
   * header carries the argument for why the root page and not every folder
   * page. Composed by `contextFootLine` so the words are still decided in one
   * place — `describeIndexProgress` is the owner-only gate as well as the
   * phrasing, and a second composition here is how a member ends up shown a
   * figure the server withheld.
   *
   * Compact only. A pointer layout says all three of these in the status strip
   * and the top bar's chip already.
   */
  const contextFoot = atContextRoot
    ? contextFootLine({
        storage: data.storage,
        fastSearch: data.fastSearch.status,
        listings: files.listings,
        // The phone's whole share of this feature: it has no file tree, so the
        // line at the foot of the context's own page is the only place a
        // number of updates can sit. Opening `activity.md` is how it is read.
        activity: data.activity,
      })
    : undefined;

  const openDocument =
    selected === null ? (
      /*
        Nothing, rather than "Choose a note", while something is on its way.

        Reported from a hard refresh of `/console/@seyi?note=…`: this region
        drew the context's name in a heading over a line telling somebody to
        choose a note — on a URL that had already chosen one. A round trip's
        worth of the opposite of what is about to happen, and then a jump.
        Blank is not a nice state either; it is a quiet one, and it is honest
        about a document that is on its way.

        **There are two gaps, and the first fix only closed one of them.**
        `pendingNote` covers the URL being read before the browser has acted on
        it, and it is `null` again the instant `select` lands — after which
        `selectedPath` names a note whose *body* is still a Convex action away,
        `entryAt` has nothing to answer with, and the empty state came back for
        the whole read. Filmed on a phone: about a tenth of a second of the
        first gap and a quarter of a second of the second. `files.opening` is
        the browser's own answer to "the selection has not arrived yet", and it
        clears on a failed read — so a note that genuinely will not open lands
        back here, under its notice, instead of on a blank page.
      */
      pendingNote == null && files.opening === null ? (
        !compact ? (
          <Empty contextLabel={contextLabel} />
        ) : landing === null ? null : (
          <FolderView
            entry={landing}
            listing={files.listings[""]}
            canSetVisibility={files.canSetVisibility}
            contextLabel={contextLabel}
            foot={contextFoot}
            onSelect={files.select}
            menu={folderMenuFor("")}
            drag={folderDrag}
            pendingStateFor={files.pending?.stateFor}
          />
        )
      ) : null
    ) : commsRoute?.kind === "inbox" ? (
      /*
        The Inbox landing page — virtual, built from the same listings a
        folder view would fetch, never a written rollup. See
        `docs/decisions/communications.md`.
      */
      <InboxView files={files} onOpen={files.select} mailConnectEnabled={MAIL_CONNECT_ENABLED} />
    ) : commsRoute?.kind === "channel" ? (
      <ChannelView
        channel={commsRoute.channel}
        account={commsRoute.account}
        path={selected.path}
        files={files}
        onOpen={files.select}
      />
    ) : commsRoute?.kind === "channel-day" ? (
      <ChannelDayView
        key={selected.path}
        channel={commsRoute.channel}
        account={commsRoute.account}
        date={commsRoute.date}
        path={selected.path}
        files={files}
        anchor={anchor}
      />
    ) : commsRoute?.kind === "contact" ? (
      <ContactPageView slug={commsRoute.slug} files={files} onOpenActivity={handleOpenComms} />
    ) : selected.kind === "folder" ? (
      <FolderView
        entry={selected}
        listing={files.listings[selected.path]}
        canSetVisibility={files.canSetVisibility}
        contextLabel={contextLabel}
        // `undefined` for every folder but the root — see `atContextRoot` and
        // `FolderView`'s header.
        foot={contextFoot}
        onSelect={files.select}
        menu={folderMenuFor(selected.path)}
        drag={folderDrag}
        pendingStateFor={files.pending?.stateFor}
      />
    ) : files.conflict?.path === selected.path ? (
      /*
        A conflict takes the region.

        Not a strip under the note and not a modal over it: answering one means
        reading two versions and, where a merge is possible, editing a proposed
        third before anything is saved. That is a document-sized surface, and
        putting it anywhere but here would mean two places to make one decision.

        Pinned to `selected.path` for the reason the share dialog is: this pane
        is reconciled with no `key` across a context switch, and a resolver
        still showing the previous note's two versions would offer to write one
        of them at the path now selected.

        Everything else stays reachable — the tree, the tabs and the rail are
        outside this region — so the conflict never strands anybody on a train
        the way blocking the whole editor would.
      */
      <ConflictResolver
        review={files.conflict}
        onKeepTheirs={files.useTheirs}
        onResolveWith={files.resolveWith}
      />
    ) : (
      <NoteEditor
        state={files.editor}
        canEdit={files.canEdit}
        reading={reading}
        presence={presence}
        drawingCollaboration={drawingCollaboration}
        /*
          `activity.md` is drawn as a list rather than as its own source — see
          `ActivityPage`. Passed from here because this is where the console's
          data and the note on screen meet; the editor decides nothing about
          which context it is in.
        */
        activity={data.activity}
        activityShared={(data.members?.members?.length ?? 1) > 1}
        /*
          Owner-only, and the rule is `capabilities.ts`'s rather than this
          expression's. Editing the activity file by hand is editing the record
          of who changed what — the authority Share and visibility are, not the
          "may write notes" an editor has. The server refuses everyone else
          anyway: the file is private, so a member or an editor never reads it
          and is served the filtered rendering instead.
        */
        activityEditable={canEditActivity(capabilitiesForRole(current?.role))}
        onOpenNote={(path) => files.select(path)}
        /*
          The one write a `member` gets. `canEdit` above is false for that role
          and this is still passed: a form block is how somebody who cannot
          write notes files a bug in a workspace they are a read-only member
          of, which is the case the feature was built for.
        */
        /*
          Plugin completions. Absent for anyone whose runtime has no actions —
          a non-owner, or a console with no plugin running — and the editor then
          installs no completion extension at all.
        */
        onSuggest={data.pluginRuntime?.actions?.askSuggestions}
        onPickSuggestion={data.pluginRuntime?.actions?.applySuggestion}
        onPreviewLinks={data.pluginRuntime?.actions?.askPreviews}
        onSubmitForm={files.submitForm}
        onReadFormResponses={files.readFormResponses}
        onVoteForm={files.voteForm}
        onUpdateFormResponse={files.updateFormResponse}
        onRetractFormResponse={files.retractFormResponse}
        folderLists={folderLists}
        /*
          Images in the note: where the bytes come from, where a pasted one
          goes, and where a refusal is said. All three from `files`, because the
          note on screen is the one it already knows about — see `loadImage`.
        */
        onLoadImage={files.loadImage}
        onStoreImage={files.storeImage}
        onImageProblem={files.say}
        /*
          What the note's own frontmatter cannot say. `visibility:` in a note
          is prose — `privacy.md` decides access — so the Properties panel
          shows the manifest's answer under that key rather than the file's,
          which is where the breadcrumb's chip has gone.
        */
        visibility={{
          visibility: selected.visibility,
          inherited: selected.inherited,
          exception: selected.exception,
          readOnly: selected.readOnly,
        }}
        notices={compact ? notices : null}
        pathBar={pathBar}
        onChange={files.setDraft}
        onSave={files.save}
        onDiscard={files.discard}
        onUseTheirs={files.useTheirs}
        onKeepMine={files.keepMine}
        /*
          FOLLOWING A LINK IS NOT THE SAME OPERATION AS TAPPING A NOTE IN THE
          TREE, AND TREATING IT AS ONE IS WHAT LOST THE NOTE YOU CAME FROM.

          This was `files.select`, on the argument that one navigation path
          means one unsaved-changes guard, one URL mirror and one remembered
          place. All three of those are still true — `nav.follow` calls the
          same `select` and honours the same refusal — and the argument was
          missing the tab: a selection opens a *preview* tab, which the next
          selection REPLACES, so following a link from A to B and then B to C
          left one tab and no way back to A but the tree.

          `nav.follow` pins it and puts it right of the tab it came from, and
          `"background"` (⌘-click) opens it without moving anybody. See
          `useTabs` and `ConsoleNavContext`.

          `undefined` where there is no console layout above this pane — the
          landing page's demo — and the editor then draws links as plain text
          rather than as a control that does nothing.
        */
        onOpenLink={nav?.follow}
        // The file tree's own listings, unioned with the search index's
        // docmap — see `linkPaths` on `FileBrowser` and "L1" in
        // `docs/decisions/app-and-console.md`. `knownNotePaths(files.listings)`
        // alone was the whole answer before the index existed, and was blind
        // to every note in a folder nobody had expanded — which on a phone,
        // where no file tree is drawn at all, was close to every note.
        notePaths={files.linkPaths}
        /*
          Absent wherever there is no context to run the passphrase machinery
          against — `noteEncryption` refuses cleanly with no workspace, but a
          console with no router or no context at all (the landing page's
          demo) has nowhere for a write to land anyway, and `undefined` here
          is what falls a passphrase note back to the plain envelope treatment
          every other encrypted note gets.
        */
        encryption={
          !settled || current?.id === undefined
            ? undefined
            : {
                controller: noteEncryption,
                onWritten: () => files.select(selected.path),
              }
        }
      />
    );

  return openDocument;
}
