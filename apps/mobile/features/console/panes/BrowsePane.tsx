import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFrame } from "../../app/AppFrame";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { Breadcrumb } from "../files/Breadcrumb";
import { FolderView } from "../files/FolderView";
import { NoteEditor } from "../files/NoteEditor";
import { ShareDialog } from "../files/ShareDialog";
import { consoleOrigin } from "../files/shareOrigin";
import { noteHeading } from "../files/frontmatter";
import { findEntry } from "../files/tree";
import { atName } from "../format";
import { selectedContext, type ConsoleData } from "../types";
import { tierSentence } from "../visibility";

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
 * breadcrumb at the top of the region. What is left is a tab strip, a
 * breadcrumb, and the document — which is what the editor was always for.
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
}: {
  data: ConsoleData;
  onOpenSettings?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const files = data.files;
  const current = selectedContext(data);
  const contextLabel = atName(current?.slug ?? "your context");

  const selected =
    files.selectedPath === null ? null : findEntry(files.listings, files.selectedPath);

  /**
   * The note the share dialog is open for, or `null`.
   *
   * Held here rather than lifted into `Explorer`'s dialog union: that state
   * belongs to the *tree*, and this is the editor region. Two entry points to
   * one dialog is not two dialogs — `ShareDialog` holds nothing of its own
   * beyond a draft recipient.
   */
  const [sharing, setSharing] = useState<string | null>(null);

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
  const frame = useFrame();

  const noBucket = data.storage === null && !data.loading;
  const manifestBroken = files.listings[""]?.manifestUsable === false;
  /*
    The one notice here that is not an event.

    Browse is the pane where an absence is invisible: a folder the owner keeps
    private does not appear in the tree, so an editor reading a short list has
    no way to tell a small context from a filtered one. That is the whole
    reason this line exists, and it is why it stays up rather than being
    dismissible — the condition it reports never stops being true. `null` for
    an owner, and `null` while the role is still loading.
  */
  const tierNote = tierSentence(current?.role);
  const hasNotice =
    tierNote !== null ||
    noBucket ||
    manifestBroken ||
    files.notice !== null ||
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
              onPress={onOpenSettings}
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
          <Button label="Dismiss" onPress={files.dismissNotice} style={styles.dismiss} />
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
  const document =
    selected === null ? (
      <Empty contextLabel={contextLabel} />
    ) : selected.kind === "folder" ? (
      <FolderView
        entry={selected}
        listing={files.listings[selected.path]}
        canSetVisibility={files.canSetVisibility}
        canShare={files.canShare}
        onSetVisibility={(visibility) => files.setVisibility(selected.path, "folder", visibility)}
        onSelect={files.select}
        onShare={() => setSharing(selected.path)}
      />
    ) : (
      <NoteEditor
        state={files.editor}
        canEdit={files.canEdit}
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
        onChange={files.setDraft}
        onSave={files.save}
        onDiscard={files.discard}
        onUseTheirs={files.useTheirs}
        onKeepMine={files.keepMine}
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

        Obsidian on iOS has no breadcrumb, and that is not an omission: on a
        phone the *sidebar* is where you navigate folders, and the note names
        itself with an inline title at the top of its own text. A path pinned
        above the document is a second band of chrome under a bar that is
        already floating there — the two rows this branch exists to collapse
        into one — and it cost the note its first screen to say something the
        drawer says better.

        So at `compact` the three things this row carried have each gone
        somewhere they belong rather than being deleted: the note's name is the
        inline title inside the document (`NoteEditor`), the visibility chip is
        a Properties row (also `NoteEditor` — `visibility:` is filing metadata),
        and Share is in the top bar's trailing group (`_layout`, where Obsidian
        puts the ⋯ container). Folder navigation is the tree's, which is the one
        thing a phone genuinely has a better surface for.
      */}
      {selected !== null && !compact ? (
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
            A note only. `FolderView` draws its own Share for a folder — the
            team-link one, which is a different offer with a different
            explanation beside it — so rendering this here as well would put
            two Share buttons on one folder screen.
          */}
          {selected.kind === "file" && files.canShare && !selected.readOnly ? (
            <Button
              label="Share…"
              onPress={() => setSharing(selected.path)}
              style={styles.share}
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
          onTeamLink={() => files.teamShareLink(sharing)}
          onRevoke={(shareId) => files.revokeShare(shareId)}
          onSetPreviewTitle={(recipient, on) =>
            files.setSharePreviewTitle(sharing, recipient, on)
          }
          onClose={() => setSharing(null)}
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
        document
      ) : compact ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{
            paddingTop: frame.contentInsets.top,
            paddingBottom: frame.contentInsets.bottom,
          }}
          scrollIndicatorInsets={{
            top: frame.contentInsets.top,
            bottom: frame.contentInsets.bottom,
          }}
          testID="browse-scroll"
        >
          {notices}
          <View style={styles.bodyCompact}>{document}</View>
        </ScrollView>
      ) : (
        <>
          {notices}
          <View style={styles.body}>{document}</View>
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
   * `flexShrink: 1` with `minWidth: 0` is what lets the path ellipsise; the
   * button carries `flexShrink: 0` so it is never the thing that gives. The
   * other way round, a long path squeezed "Share…" to "Sha…", which is a
   * control nobody presses on the theory that it might do something else.
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
  share: { flexGrow: 0, flexShrink: 0 },
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

  empty: { padding: space.x6, gap: space.x2, maxWidth: 520 },
  emptyLine: { marginTop: 2 },

  folder: { gap: 14, maxWidth: 620 },
  folderAction: { alignSelf: "flex-start" },
});
