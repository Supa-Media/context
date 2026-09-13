import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { FrameIconButton } from "../../app/AppFrame";
import { ScreenViewport, useSurfacePadding } from "../../app/Screen";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { NavBand } from "../NavBand";
import { Breadcrumb } from "../files/Breadcrumb";
import { ConflictResolver } from "../files/ConflictResolver";
import { contextFootLine } from "../files/contextFoot";
import { EncryptionAdvancedSection } from "../encryption/EncryptionAdvancedSection";
import { useNoteEncryption } from "../encryption/useNoteEncryption";
import { useNoteLockPropagation } from "../encryption/lockPropagation";
import { FolderView } from "../files/FolderView";
import { NoteEditor } from "../files/NoteEditor";
import { setReadMode, useReadMode } from "../files/readMode";
import {
  STORAGE_MIGRATION_OFFER,
  StorageMigrationActions,
  storageMigrationWorthOffering,
  useStorageMigrationOffer,
} from "../storage/StorageMigration";
import { ShareDialog } from "../files/ShareDialog";
import { consoleOrigin } from "../files/shareOrigin";
import { noteHeading } from "../files/frontmatter";
import { entryAt } from "../files/tree";
import { atName } from "../format";
import { selectedContext, type ConsoleData } from "../types";
import { tierSentence } from "../visibility";
import { ChannelDayView } from "../communications/ChannelDayView";
import { ChannelView } from "../communications/ChannelView";
import { ContactPageView } from "../communications/ContactPageView";
import { InboxView } from "../communications/InboxView";
import { MAIL_CONNECT_ENABLED } from "../communications/flags";
import { classifyCommsPath } from "../communications/paths";
import { removalHandler } from "../files/access";
import type { SettingsSectionKey } from "../settings/sections";

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
  /**
   * Opens this context's settings. Absent where there is nowhere to go, and the
   * control is then not rendered rather than rendered dead.
   */
  onOpenSettings,
  pendingNote,
  anchor,
  onOpenComms,
}: {
  data: ConsoleData;
  /**
   * Optionally at a named section — which is what lets a control deep-link to
   * the place its own answer lives: the share dialog's group row sends you to
   * `groups`, because who is in a group is decided there and nowhere else.
   * Called with nothing, it opens where the gear always did.
   */
  onOpenSettings?: (section?: SettingsSectionKey) => void;
  /**
   * The note this URL names, if it names one.
   *
   * The first of the two gaps between landing on `/console/@slug?note=…` and
   * seeing that note: the URL has been read and the browser has not acted on
   * it yet. The second gap — the browser reading the note's body — is
   * `files.opening`, and both are answered in the same place. See the comment
   * on `openDocument`.
   */
  pendingNote?: string | null;
  /**
   * `?anchor=`, read once at the route — see `nav.ts`'s `noteHref` and
   * `anchorFromQuery`. Meaningful only to a channel-day view; every other
   * branch below ignores it, the same way an ordinary note ignores `?note=`
   * naming a folder.
   */
  anchor?: string | null;
  /**
   * Open a communications path from inside a comms view — a contact's
   * activity link, today. **Not `files.select`**: an activity link names an
   * anchor as well as a path, and `select` has no way to carry one. The
   * caller does a real navigation (`router.push(noteHref(slug, path,
   * anchor))`), which is the same URL a pasted link or a search result would
   * use — so this view never invents a second way to reach "note plus
   * anchor". Absent on a console with no router behind it (the landing
   * page's demo, `e2e-fixture`'s own wiring), in which case activity links
   * still open the day — `files.select`, anchor dropped — rather than doing
   * nothing.
   */
  onOpenComms?: (path: string, anchor?: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const files = data.files;
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
  const [sharing, setSharing] = useState<string | null>(null);

  /**
   * The passphrase machinery for this context, and nowhere else.
   *
   * One instance per context rather than one per open note: the unlock
   * session (`session.ts`) is deliberately a property of "the room you are
   * in", not of any one file — locking is total, and a note unlocked five
   * minutes ago in a tab that has since moved elsewhere still counts against
   * the idle timeout. `workspaceId` is `null` while the context is settling
   * (`!settled`, above) or has no bucket at all, and every operation this
   * hook exposes refuses cleanly rather than acting against the wrong
   * context's actions.
   */
  const noteEncryption = useNoteEncryption(
    settled ? (current?.id ?? null) : null,
    undefined,
    data.encryptionWriters,
  );
  const announceNoteLock = useNoteLockPropagation(
    settled ? (current?.id ?? null) : null,
    (path) => {
      noteEncryption.close(path);
      files.encryptedElsewhere(path);
    },
  );

  /**
   * The one error the "Password-encrypt content" dialog shows, if the write
   * that locks the note failed. Held here rather than inside
   * `EncryptionAdvancedSection` because the operation it reports on
   * (`noteEncryption.protect`) is called from here, against `files.editor`.
   */
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<string | undefined>(undefined);

  /*
    The note runs to the edges of the glass on a phone, and the padding that
    used to sit here belongs to the document instead — see `NoteEditor`. A
    16pt frame around a note *plus* the note's own reading margin is 36pt of
    gutter on a 390pt screen, and it is what made the measure wrap every six
    words in the before shot.
  */
  const compact = densityFor(useWindowDimensions().width) === "compact";
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

  /*
    `=== null`, and never `!== undefined`. A binding that has not answered is
    not a context without one — see `ConsoleData.storage`. The `!data.loading`
    that used to stand here looked like the same guard and was not: `loading`
    is the *workspace list*, and the binding is a round trip behind it, so this
    banner offered to connect a bucket that was already connected on every
    refresh.
  */
  const noBucket = data.storage === null;
  const manifestBroken = files.listings[""]?.manifestUsable === false;
  /**
   * The one-time storage-layout update, offered where it can be ignored.
   *
   * It used to be a gear in the file tree's toolbar — permanent chrome for an
   * operation somebody runs once or never — and it is a line in this band
   * instead, with its permanent home in Settings → Storage. Both surfaces are
   * gated on the same absent-or-present `updateStorageLayout`, which is
   * owner-only; nothing here decides who may run it.
   *
   * The workspace is what the *browser* says it is, not the console: this
   * notice belongs to the listings on screen, and `files.contextId` is what
   * everything else in this pane is drawn from while a switch settles.
   *
   * `storageMigrationWorthOffering` is the half that belongs to the notice
   * and not to the control — see its own comment. An owner with no bucket
   * connected is being told so by the warn notice below, and offering to
   * reorganize the hidden files of a bucket that does not exist under it is
   * noise at the worst possible moment.
   */
  const storageMigration = useStorageMigrationOffer(
    files.updateStorageLayout === undefined || !storageMigrationWorthOffering(data.storage)
      ? null
      : files.contextId,
  );
  /*
    The one notice here that is not an event, and the one that is drawn **once
    per context rather than once per file**.

    Browse is the pane where an absence is invisible: a folder the owner keeps
    private does not appear in the tree, so an editor reading a short list has
    no way to tell a small context from a filtered one. That is why the line
    exists, and why it is not dismissible — the condition it reports never stops
    being true.

    It is a fact about the *context* rather than about the note in front of
    you, and for a while that was read as "so draw it only where nothing is
    open". The reading was wrong in the case that matters most: a team link
    opens straight into a note or a folder, so the person who has never seen
    this context — looking at a listing with things absent from it — was the one
    person the notice never reached. What made that look safe was a comment
    claiming the chip at the foot of the file tree carried the same claim
    inside a note. **There is no such chip on a phone**, and a safeguard
    asserted in a comment and missing from the screen is worse than none,
    because it stops anybody looking for the real one.

    So it is drawn wherever you are, and it is *one line*. The paragraph behind
    it — `tierExplanation` — is not printed here: its own docstring says it
    belongs where somebody has gone looking for it and not on every screen, and
    the line now is on every screen. It lives on the members card, beside the
    owner's half of the same fact.

    Once per screen, still: this is the only place it is built, and it reaches a
    note through `notices` and a folder through the page scroller — the two
    branches at the foot of this file, never both.

    `null` for an owner, and `null` while the role is still loading — by
    construction in `tierSentence` rather than by a check here; see its comment.
  */
  const tierNote = tierSentence(current?.role);
  const hasNotice =
    tierNote !== null ||
    noBucket ||
    manifestBroken ||
    files.notice !== null ||
    storageMigration.visible ||
    (files.readOnlyReason !== undefined && !files.canEdit);

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
    <View style={[styles.notices, compact && styles.noticesCompact]}>
      {tierNote !== null ? (
        <View style={styles.notice} testID="browse-tier-notice">
          {/*
            The sentence without the chip. The chip is in the top bar, on
            every route of this context — repeating it two inches below
            reads as two different claims rather than one. What earns its
            height here is the sentence: a private folder in this tree is
            not dimmed, it is *absent*, so somebody reading a short list
            otherwise cannot tell a small context from a filtered one.
          */}
          <Text variant="hint">{tierNote}</Text>
        </View>
      ) : null}

      {files.readOnlyReason !== undefined && !files.canEdit ? (
        <View style={styles.notice}>
          <Text variant="hint">{files.readOnlyReason}</Text>
        </View>
      ) : null}

      {noBucket ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            No bucket is connected to this context yet, so there is nowhere to keep notes.
            Point it at an S3-compatible bucket you own and everything here starts working
            — your name and your capture address are already yours.
          </Text>
          {onOpenSettings ? (
            <Button
              label="Connect a bucket"
              /*
                Called in a lambda, and with the section it means.

                `onPress={onOpenSettings}` read as a tidy pass-through and was
                a dead button: React Native hands a press handler its
                `GestureResponderEvent`, `onOpenSettings` takes an optional
                *section key*, so the event arrived as the section and the
                route was asked for `?settings=[object Object]` — which
                resolves to nothing. `browseNoticeActions.test.ts` presses it
                and asserts what it was called with.

                `storage` rather than nothing: the button says "Connect a
                bucket", and opening settings at Overview to go hunting for
                the Storage section is the same defect one screen further on.
              */
              onPress={() => onOpenSettings("storage")}
              style={styles.dismiss}
              testID="browse-connect-storage"
            />
          ) : null}
        </View>
      ) : null}

      {manifestBroken ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          {/*
            This used to end "Write a valid privacy.md at the root of the
            bucket, or ask a connected AI client to", and **neither was
            possible**. Every write path in the product refuses that key:
            the console's own `writeFile` answers
            PRIVACY_MANIFEST_READ_ONLY, the gateway's `write_note` answers
            "that path is reserved", and `set_folder_visibility` answers
            "privacy.md is required before folder visibility can be
            changed". The only exit was rclone or the provider's web
            console — so the sentence sent people to try two things that
            cannot work, in a state where nothing else works either.

            The button is the exit. It is absent rather than disabled for
            anyone who is not the owner, so the copy has to carry both
            cases: an editor reads the same explanation and is told whose
            fix it is.
          */}
          <Text variant="hint" style={styles.noticeWarnText}>
            privacy.md is missing or could not be read, so everything is treated as private
            and nothing can be shared until it is fixed. Nothing is exposed by this — it
            fails closed.{" "}
            {files.canResetPrivacy
              ? "Resetting it writes a fresh one declaring the folders this bucket has, every one of them private, and keeps the unreadable file in .history/. Nothing becomes visible to anybody; you choose what to share afterwards."
              : "Only the owner of this context can rewrite it — ask them to reset it from their console, or fix it in the bucket directly."}
          </Text>
          {files.canResetPrivacy ? (
            <Button
              label="Reset privacy.md"
              onPress={files.resetPrivacy}
              disabled={files.busy}
              style={styles.dismiss}
              testID="browse-reset-privacy"
            />
          ) : null}
        </View>
      ) : null}

      {files.notice !== null ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            {files.notice}
          </Text>
          {/*
            Also in a lambda, for the reason the button above gives: this one
            takes no arguments so the press event was harmless, and the next
            person to give it a parameter would inherit a silent bug rather
            than a failing test.
          */}
          <Button
            label="Dismiss"
            onPress={() => files.dismissNotice()}
            style={styles.dismiss}
            testID="browse-dismiss-notice"
          />
        </View>
      ) : null}

      {/*
        Last, and the only line here that is an *offer* rather than a report.

        No wash: the warn colours in this band mean "something is wrong and it
        is yours to fix", and nothing is wrong. It is the hint treatment the
        tier line uses, with two buttons — one to run it, one to stop being
        asked — and the dialog behind the first is the same one both entry
        points raise.
      */}
      {storageMigration.visible && files.updateStorageLayout !== undefined ? (
        <View style={styles.notice} testID="browse-storage-migration">
          <Text variant="hint">{STORAGE_MIGRATION_OFFER}</Text>
          <StorageMigrationActions
            run={files.updateStorageLayout}
            onDismiss={storageMigration.dismiss}
            style={styles.noticeActions}
          />
        </View>
      ) : null}
    </View>
  );

  /**
   * The three things that can be in front of somebody, built once.
   *
   * They are placed differently at the two densities — a phone scrolls a folder
   * listing as a page and hands a note its own scroller — and building them
   * here rather than in each branch is what stops the two placements drifting
   * into two sets of props.
   */
  /**
   * Where you are, and the way up — the phone's answer to both.
   *
   * Built here and handed to two surfaces, because a note and a folder scroll
   * in different containers on a phone: a note brings its own (see the comment
   * on the branch below, and `NoteEditor.pathBar`), a folder sits in this
   * pane's. One node passed twice rather than two copies of the same line —
   * `NoteEditor`'s own header states the rule this follows: two copies of a
   * tree is how a control ends up on one surface and missing from the other.
   *
   * `pathOnly` is the subtractive form: ancestors, pressable, and none of the
   * naming a phone already does inside the document. `Breadcrumb`'s header has
   * the argument.
   *
   * **The path is the second row of `NavBand`, not the whole of it.** The
   * contexts are the first, and they are here rather than in the floating top
   * bar because navigation that lies across somebody's note is an overlap
   * rather than reachability — `NavBand` has that argument and the duplication
   * argument beside it. The band is built even with nothing selected, because
   * the contexts do not depend on a selection; it draws nothing at all off a
   * phone, where the rail is the contexts and the full breadcrumb is the path.
   */
  const pathBar = compact ? (
    <NavBand
      /*
        The note's own margin, so the pills and the path line up with the first
        character of the document under them rather than with the edge of the
        glass. `NavBand` takes it from here for the reason its `band` style
        gives: only the caller knows what the band is sitting above.
      */
      gutter={layout.readingMargin}
      /*
        A fresh row, not a scrolled one, whenever "where you are" changes.
        `files.contextId` as well as the path: a switch that happens to land on
        a note or folder with the same name in the new context (`index.md`, an
        `@lk`/`@seyi` `1-projects` folder) is still a different position, and
        the row's own scroll offset has no way to tell those apart on its own.
        See `NavBand`'s `trailKey` for what not doing this costs.
      */
      trailKey={`${files.contextId ?? ""}:${selected?.path ?? ""}`}
      path={
        selected === null || !settled ? null : (
          <Breadcrumb
            pathOnly
            path={selected.path}
            /*
              What the note calls itself, where it calls itself anything — the
              same rule the pointer layout's breadcrumb applies, and passed here
              for the same reason. A captured note's filename is a content hash,
              so on a phone the only line naming what is on screen was naming
              nothing.

              Only when the editor is holding *this* note: `files.editor` is one
              buffer and the selection can move ahead of it, so titling the
              crumb from a draft belonging to a different path would put one
              note's subject over another note's name.
            */
            title={
              selected.kind === "file" && files.editor.path === selected.path
                ? noteHeading(files.editor.draft, selected.path)
                : undefined
            }
            contextLabel={contextLabel}
            visibility={selected.visibility}
            inherited={selected.inherited}
            exception={selected.exception}
            readOnly={selected.readOnly}
            onSelectFolder={files.select}
          />
        )
      }
    />
  ) : null;

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
   * `R2 · brain · 62% indexed · 12 notes, 8 folders`, for the context's own
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
      })
    : undefined;

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
        channel={commsRoute.channel}
        account={commsRoute.account}
        date={commsRoute.date}
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
        /*
          The one write a `member` gets. `canEdit` above is false for that role
          and this is still passed: a form block is how somebody who cannot
          write notes files a bug in a workspace they are a read-only member
          of, which is the case the feature was built for.
        */
        onSubmitForm={files.submitForm}
        onReadFormResponses={files.readFormResponses}
        onVoteForm={files.voteForm}
        onUpdateFormResponse={files.updateFormResponse}
        onRetractFormResponse={files.retractFormResponse}
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
          Following a link is the same operation as tapping a note in the tree,
          and it goes through the same `select` — so the unsaved-changes guard
          refuses it the same way, the URL follows it (`useNoteAddress`), and
          the device remembers where it left somebody. A second navigation path
          here would be a second set of all three.
        */
        onOpenLink={files.select}
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
        <View style={[styles.noteHead, compact && styles.noteHeadCompact]}>
          <View style={styles.crumb}>
            <Breadcrumb
              path={selected.path}
              /*
                What the note calls itself, where it calls itself anything.

                Only when the editor is holding *this* note: `files.editor` is
                one buffer and the selection can move ahead of it, so titling
                the breadcrumb from a draft belonging to a different path would
                put one note's subject over another note's name. A folder has no
                text and gets no title, which leaves `baseName` — its own name,
                which is what a folder is called.
              */
              title={
                selected.kind === "file" && files.editor.path === selected.path
                  ? noteHeading(files.editor.draft, selected.path)
                  : undefined
              }
              contextLabel={contextLabel}
              visibility={selected.visibility}
              inherited={selected.inherited}
              exception={selected.exception}
              readOnly={selected.readOnly}
              onSelectFolder={files.select}
            />
          </View>
          {/*
            Share is here, beside the note, and not only in the row's menu.

            It was menu-only first, and that made it a feature nobody had: on a
            phone the menu is a long-press on a *file row*, so somebody reading
            a note — which is exactly when they decide to send it to a
            colleague — had no row to press and no button to find. `Empty`
            below already states the rule this broke: "a right-click menu
            nobody discovers is a feature nobody has."

            It stays in the menu too. The menu is how you act on a note you are
            not looking at; this is how you act on the one you are.

            Absent rather than disabled for anyone who is not the owner, and
            absent for `privacy.md` and anything else read-only — the same rule
            the menu applies, and the server refuses it regardless with
            `minimum: "owner"`.
          */}
          {/*
            A folder as well as a note. `FolderView` used to draw its own pair
            and no longer does — see its header — so this is the one place a
            pointer layout offers either, and the phone's answer is the frame's
            trailing group. What a share *means* still differs by kind, and
            that is `ShareDialog`'s to say rather than this button's.
          */}
          {/*
            Absent for a group rule, the console's own rule for a control
            somebody may not use. The two-word button has no true label for
            `@supa-leads` — it said "Share with team", and pressing it did
            exactly that to a note the owner had held back.
          */}
          {/*
            One control, and it is the phone's glyph.

            This row carried two filled word-buttons — "Make private" and
            "Share…" — which were the widest thing in the bar, and #461 turned
            both into icons. That was half right and half a regression: the
            *padlock* is a control `_layout.tsx` had already taken off the
            phone, and its comment there says why — "two controls for one
            question", overlapping on the dangerous state, with audience moved
            inside the sheet as named positions and the public step confirmed in
            words. Drawing it here as a 20pt icon reintroduced on a pointer
            layout exactly what the phone removed, which is the opposite of
            matching it.

            So visibility is gone from this row. `ShareDialog` below already
            takes `onSetScope`, so nothing moved and nothing is unreachable —
            audience is set where the phone sets it, and `scope.ts` is still the
            one model every surface goes through.

            Share stays, unfilled rather than in a capsule: `AppFrame`'s
            trailing group is a floating container over a document and is itself
            the object, while this bar has a surface and a hairline already, so a
            box around one glyph would be the box-in-a-box the frame's own
            comment refuses at every density but the phone.
          */}
          {/*
            READING MODE, ON THE LAYOUT THAT HAD NO WAY INTO IT.

            The eye was added to `AppFrame`'s trailing group, and that group is
            **only drawn on a phone** — `_layout.tsx` passes `topTrailing` under
            `phone ? … : …` and the pointer branch carries the tier and storage
            chips instead. So reading mode shipped reachable on a 390pt screen
            and unreachable in a browser, which is where it was asked for: "add
            this to web as well because it doesn't show up on web".

            Same bus, same state, same label rule as the phone's — one control
            in two places rather than two controls, and `readable` there is the
            same condition as `kind === "file"` here. A **folder** selects this
            row too and gets no eye: there is no document to read, which is the
            reason `_layout.tsx` gives for the same gate.
          */}
          {selected.kind === "file" ? (
            <FrameIconButton
              icon="eye"
              label={reading ? "Edit this note" : "Read this note"}
              selected={reading}
              onPress={() => setReadMode(!reading)}
              testID="browse-read"
            />
          ) : null}
          {files.canShare && !selected.readOnly ? (
            <FrameIconButton
              icon="share"
              label="Share this"
              onPress={() => setSharing(selected.path)}
              testID="browse-share"
            />
          ) : null}
        </View>
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
        <ShareDialog
          path={sharing}
          shares={files.shares}
          origin={consoleOrigin()}
          onShare={(recipient) => files.share(sharing, recipient)}
          onCopyLink={files.copyShareLink}
          onRevoke={(shareId) => files.revokeShare(shareId)}
          onSetPreviewTitle={(share, on) =>
            files.setSharePreviewTitle(sharing, share, on)
          }
          onClose={() => setSharing(null)}
          /*
            Only what the server already decided: `selected.visibility` came off
            the listing's own `effectiveVisibility` at this caller's scope, and
            `access.ts` joins it to the membership without evaluating anything.

            `data.members` rather than a `useMembers` of this pane's own: the
            console already holds one subscription for the People section, and a
            second one here made every BrowsePane render test reach for a Convex
            provider it does not have — 96 of them. One subscription, read in
            two places.
          */
          /*
            Only what this caller may actually do. `data.groups.actions` is
            absent for anybody who is not an owner — `listGroups` and
            `setNoteGroup` are both owner-only — so the field offers no group
            rows rather than offering a pick that would be refused. Optional
            all the way down: a data shape without groups at all offers none,
            which is the same answer and the right one.
          */
          groups={
            data.groups?.actions === undefined
              ? undefined
              : data.groups.groups.map((group) => ({
                  name: group.name,
                  label: group.label,
                  liveCount: group.members.filter((member) => member.live).length,
                }))
          }
          onShareWithGroup={
            data.groups?.actions === undefined
              ? undefined
              : (group) => files.shareWithGroup(sharing, group)
          }
          /*
            Make one here, and point this note at it in the same press. The
            group is created, populated, and then named as this note's rule —
            which is the whole sequence somebody previously did by hand across
            two screens.
          */
          entryKind={selected.kind}
          onSetScope={
            files.canSetVisibility
              ? (from, to) => files.setScope(sharing, selected.kind, from, to)
              : undefined
          }
          groupSlug={current?.slug}
          onCreateGroup={
            data.groups?.actions === undefined
              ? undefined
              : (label, userIds) =>
                  data
                    .groups!.actions!.createWith(label, userIds)
                    .then((name) => files.shareWithGroup(sharing, name))
          }
          access={{
            visibility: selected.visibility,
            exception: selected.exception,
            members: data.members?.members,
          }}
          /*
            What a row can actually do about somebody. Each half is present
            only where this caller holds it: `setPrivate` needs write access to
            the manifest, `removeMember` is owner-only in `apps/convex`, and
            `removalHandler` returns `undefined` when neither is — so a
            non-owner's rows draw their role, exactly as they always did.
          */
          onRemovalRoute={removalHandler({
            path: sharing,
            kind: selected.kind,
            setPrivate: (path, kind) => files.setVisibility(path, kind, "private"),
            removeMember: data.members?.actions?.remove,
            openGroups:
              data.groups?.actions === undefined || onOpenSettings === undefined
                ? undefined
                : () => onOpenSettings("groups"),
          })}
          /*
            Only when the editor is actually holding this note — the same
            guard the breadcrumb's title uses, for the same reason: the
            plaintext this locks is `files.editor.draft`, and a draft
            belonging to a different path is a different note's content.
          */
          advanced={
            files.editor.path !== sharing ? undefined : (
              <EncryptionAdvancedSection
                path={sharing}
                encrypted={files.editor.encrypted}
                busy={lockBusy}
                error={lockError}
                onLock={(passphrase) => {
                  setLockBusy(true);
                  setLockError(undefined);
                  noteEncryption
                    .protect({
                      path: sharing,
                      plaintext: files.editor.draft,
                      etag: files.editor.etag,
                      passphrase,
                    })
                    .then(() => {
                      /*
                        The lock just wrote an envelope over `sharing`. The
                        plaintext this call sent — `files.editor.draft` above
                        — is exactly what a local draft or a queued write for
                        this path would also be holding, and either one left
                        behind would be a plaintext copy sitting outside the
                        envelope this success is the whole promise of closing.
                        `useNoteEncryption.ts`'s own header explains why this
                        cannot be that call's job: it never touches
                        `features/offline`, on purpose, so the door has to be
                        reached from out here instead. See `discardLocalCopies`'s
                        own comment on `FileBrowser` for the rest of the
                        argument, including the boundary this keeps rather
                        than widens.

                        Before `select`, not after: `select` is what makes
                        `files.editor.path` this note's next open, and
                        `openNote` now refuses to restore anything for an
                        encrypted note regardless — but there is no reason to
                        depend on that ordering here when this is the one
                        call that actually knows a lock, not a mere reopen,
                        is what just happened.
                      */
                      files.discardLocalCopies(sharing);
                      announceNoteLock(sharing);
                      // Reopen so `files.editor.encrypted` catches up — the
                      // note this session just locked is unlocked in it
                      // already (`useNoteEncryption.protect` leaves it so),
                      // but the ordinary editor state still shows the
                      // plaintext it had a moment ago until it re-reads.
                      files.select(sharing);
                    })
                    .catch((caught: unknown) => {
                      setLockError(
                        caught instanceof Error ? caught.message : "That did not work.",
                      );
                    })
                    .finally(() => setLockBusy(false));
                }}
              />
            )
          }
        />
      ) : null}

      {/*
        The document, and the one full-bleed scroll surface it lives on.

        On a phone nothing here is a band the note is kept out of. The region
        runs from the top of the glass to the bottom, the toolbar and the top
        bar lie over it, and the scroller pays for both in **content padding**
        with matching `scrollIndicatorInsets` — so the first line and the last
        can each be brought out from under the chrome and everything between
        passes behind it. Padding the content rather than shrinking the viewport
        is the whole difference: a scroller that stops where the toolbar begins
        has a hard edge across the glass and can never scroll its last line
        clear of anything.

        A note brings its own scroller rather than sitting in this one, and that
        is not a preference. `NoteAccessory` rides above the keyboard by being
        absolutely positioned at the bottom of the *region*; inside a scroll
        container it would anchor to the bottom of the content instead and ride
        away with it. So `NoteEditor` owns a scroller with the accessory bar as
        its sibling, and takes the notices as a prop so they scroll with the
        document rather than pinning a band above it.
      */}
      {compact && selected !== null && selected.kind === "file" ? (
        openDocument
      ) : compact ? (
        /*
          The status bar's band goes on the box *around* the scroller and our
          own chrome inside it — see `SurfacePadding` in `app/frame.ts`. Spent
          together on the content, the whole inset scrolled away with the
          listing and the folder's rows rode up under the clock.
        */
        <ScreenViewport padding={padding}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{
              paddingTop: padding.content.top,
              paddingBottom: padding.content.bottom,
            }}
            scrollIndicatorInsets={{
              top: padding.content.top,
              bottom: padding.content.bottom,
            }}
            testID="browse-scroll"
          >
            {/*
              Where you are, and the way up — on a phone, where the drawer was
              the only answer to both.

              This line is the reversal of a stated decision, so it is worth
              saying what changed rather than letting the comment above go
              quietly untrue. The breadcrumb was dropped here because Obsidian
              spends nothing on it and the note names itself inside the
              document, which is right about *naming* and was wrong about
              *navigation*: a folder page reached by a link had no route to its
              parent at all, and the only way to another folder was the drawer,
              which is the surface a phone makes hardest to get at. `pathOnly`
              is the half that navigates and none of the half that labelled.

              Inside the scroller rather than pinned above it, so it scrolls
              away with the document: it answers a question people ask on
              arrival, and a permanent band is a band that costs a line of the
              note forever. It rides below the floating chrome because the
              scroller already pays `padding.content.top` for it.
            */}
            {pathBar}
            {notices}
            <View style={styles.bodyCompact}>{openDocument}</View>
          </ScrollView>
        </ScreenViewport>
      ) : (
        <>
          {notices}
          <View style={styles.body}>{openDocument}</View>
        </>
      )}
    </View>
  );
}

/**
 * Nothing open.
 *
 * Says how to open something rather than just that nothing is — and names the
 * gesture that is new, because a right-click menu nobody discovers is a feature
 * that does not exist.
 */
function Empty({ contextLabel }: { contextLabel: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {contextLabel}
      </Text>
      <Text variant="paneSub" style={styles.emptyLine}>
        Choose a note to read or edit it. Right-click any row — or press and hold on a phone —
        for everything you can do to it.
      </Text>
    </View>
  );
}


const makeStyles = (colors: Colors) => StyleSheet.create({
  /** The editor region: chrome on its top edge, the document filling the rest. */
  region: { flex: 1, minHeight: 0 },
  /**
   * The breadcrumb takes the room it needs; Share sits at the end of the line.
   *
   * **The row reserves its own height, and that is the whole fix for an
   * overlap that looked like a stacking bug.** Share was drawing on top of the
   * note's name, and the cause was not z-index: this row had no vertical
   * padding, `Breadcrumb.barCompact` zeroed its own `paddingTop`, and `Button`
   * brings `paddingVertical: 6`. So the row's height was the crumb's line box —
   * shorter than the button inside it — and the button overflowed in both
   * directions onto whatever was drawn next. A row that is at least as tall as
   * the tallest thing in it cannot overlap anything.
   *
   * `minHeight` rather than a fixed height: the crumb is one line today and a
   * longer context name is one word from being two.
   */
  noteHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    minHeight: layout.minTouchTarget,
  },
  /**
   * The breadcrumb yields first.
   *
   * `flexShrink: 1` with `minWidth: 0` is what lets the path ellipsise. The
   * actions beside it never give: React Native's `flexShrink` defaults to `0`,
   * so a `FrameIconButton` holds its target while the path ellipsises around
   * it. They used to carry `flexShrink: 0` explicitly because they were word
   * buttons, and a long path squeezed "Share…" to "Sha…" — a control nobody
   * presses on the theory that it might do something else. A glyph cannot be
   * truncated into a different glyph, so that failure went with the words
   * rather than being guarded against.
   */
  /**
   * The trailing margin the breadcrumb carries and Share does not.
   *
   * `Breadcrumb.barCompact` pads itself to `layout.readingMargin` so the path
   * lines up with the first character of the note. Share sits outside that
   * `View`, so without this it hangs on the edge of the glass.
   */
  noteHeadCompact: { paddingRight: layout.readingMargin },
  crumb: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0, padding: space.x4 },
  /**
   * The phone's page scroller: full-bleed, with the chrome paid for in content
   * padding at the call site rather than in a shorter viewport here.
   */
  scroll: { flex: 1, minHeight: 0 },
  /**
   * No padding, and no `flex: 1`.
   *
   * The document runs to the edges of the glass and what padding there is
   * belongs to it. `flex` is gone because this now sits inside a scroller's
   * content, where a flex child of a `contentContainer` has nothing to fill and
   * would collapse a folder listing to nothing.
   */
  bodyCompact: { padding: 0 },

  notices: { paddingHorizontal: space.x4, paddingTop: space.x3, gap: space.x2 },
  noticesCompact: { paddingHorizontal: layout.readingMargin, paddingTop: space.x2 },
  notice: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    backgroundColor: colors.hintWash,
    gap: 10,
  },
  noticeWarn: { borderColor: colors.warnBorder, backgroundColor: colors.warnWash },
  noticeWarnText: { color: colors.warnText },
  dismiss: { alignSelf: "flex-start" },
  /**
   * Two buttons under a notice rather than one.
   *
   * `dismiss`'s `alignSelf` does the same job for a single control; a row
   * needs to wrap instead, because "Update Context storage" beside "Not now"
   * is wider than a 390pt phone's notice at its own padding.
   */
  noticeActions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },

  empty: { padding: space.x6, gap: space.x2, maxWidth: 520 },
  emptyLine: { marginTop: 2 },

  folder: { gap: 14, maxWidth: 620 },
  folderAction: { alignSelf: "flex-start" },
});
