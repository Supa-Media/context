import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Reveal } from "../../../design/components/Reveal";
import { Text } from "../../../design/components/Text";
import { noteHeading, noteHeadingSource } from "../frontmatter";
import { NameField } from "../NameField";
import { noteGutterFor } from "../../../app/frame";
import { pointerType } from "../../../design/tokens";
import { EncryptedNotice, ManifestNotice } from "./notices";
import { noteDocument } from "./document";
import { layout } from "../../../design/tokens";
import { RecentRunsSection } from "../../routines/RecentRuns";
import type { NoteView } from "./view";
import { InTrashPill, RESTORE_BAR_ROOM, TrashedByline } from "./trashed";

/** How far the inline title's edit tint reaches past its text, each side. */
const TITLE_INSET = 6;

/**
 * Everything that scrolls, as one node — see the call site in `NoteEditor`,
 * which says why it is built once rather than written per density.
 */
export function noteFlow(view: NoteView) {
  const {
    compact,
    pathBar,
    notices,
    passphraseLocked,
    state,
    styles,
    titled,
    onUseTheirs,
    onKeepMine,
    explains,
    canDiscard,
    manualSave,
    durability,
    onDiscard,
    button,
    onSave,
    nameEdit,
    drawing,
    activityList,
    docWidth,
    trashed,
    commenter,
  } = view;
  /*
    THE NAME, AS A FIELD, WHERE THE NOTE HAS NO TITLE OF ITS OWN.

    "We should be able to rename a note from the note header itself"
    (owner, 2026-10-14). A note's first heading is its name and renames it
    (`linkedTitle.ts`), and one whose front matter names it is called that. What was left is a note named by nothing but its file — an
    empty `untitled-<date>`, a note that opens with prose — and on a pointer
    layout that note showed no name on its page at all. So that note draws
    its file name over the body as Obsidian's inline title does, and the
    title is a field: click, type, Enter renames (`noteName.ts`).

    Not for a drawing (the canvas is the page) or the activity list (a file
    the product writes), and not for a locked note.
  */
  const nameable =
    nameEdit !== undefined &&
    state.path !== null &&
    !drawing &&
    !activityList &&
    !passphraseLocked &&
    noteHeadingSource(state.draft, state.path) === "filename";
  return (
  <>
    {compact ? pathBar : null}
    {compact ? notices : null}
    {/*
      A passphrase note gets `LockedNoteView` below instead of the raw
      envelope, and `LockedNoteView` says everything `EncryptedNotice`
      would — printing both would say the same thing twice, once truthfully
      ("we cannot read this") and once in words written for the mode that
      is not this one ("readable through a connected client", which is
      exactly false for a passphrase note).
    */}
    {passphraseLocked ? null : state.encrypted ? <EncryptedNotice /> : state.readOnly ? <ManifestNotice /> : null}
    {/* A phone has no path line, so "In trash" sits over the title (`trashed.tsx`). */}
    {compact && trashed !== undefined ? <InTrashPill style={styles.trashedPill} /> : null}

    {/*
      The note's name, inside the note — Obsidian's inline title.

      It is the first thing in the document rather than a line of chrome above
      it, which is the whole point: it scrolls with the text and passes under
      the floating toolbar exactly as the first paragraph does. A path pinned
      above the document was the second of the two bands this branch exists to
      collapse, and it named the note *worse* — at three segments and a chip
      the line ellipsised at both ends on a 390pt screen.

      `noteHeading` decides what a note is called: its frontmatter's `title`
      or `subject`, then the body's own `# Heading`, then the filename. A
      captured note's filename is a content hash, which is the case that
      argument exists for.

      As text, compact only: a pointer layout's header line names the note.
      As a field (`nameable` above), every density, because there it is how
      the note is renamed, and Obsidian draws it under its path line too.

      And `titled` only: when the name came from the body's own `# H1`, that
      heading is already on screen and drawing it here too shows one string
      twice on the first screen. The heading stays and the title steps aside,
      rather than the other way round — `body` below is the editor's buffer on
      a phone, so removing a line from it would delete it from the file.
    */}
    {/*
      `state.path` is `null` only for the empty editor, which this pane never
      renders — `BrowsePane` draws `Empty` instead. Guarded rather than
      asserted, because a heading row with nothing in it reads as a broken
      screen and `noteHeading` refuses to invent one.
    */}
    {compact && nameable ? (
      <NameField
        name={nameEdit!.name}
        onCommit={nameEdit!.onCommit}
        fontSize={pointerType.title}
        style={styles.inlineTitle}
        label="Note name"
        testID="note-inline-title"
      />
    ) : !compact && nameable ? (
      <NameField
        name={nameEdit!.name}
        onCommit={nameEdit!.onCommit}
        fontSize={pointerType.title}
        style={[
          styles.inlineTitlePointer,
          // The text starts at the note's first character; the edit tint
          // reaches a few points past it either side rather than to the edges.
          { marginHorizontal: Math.max(noteGutterFor(docWidth) - TITLE_INSET, 0), paddingHorizontal: TITLE_INSET },
        ]}
        label="Note name"
        testID="note-inline-title"
      />
    ) : compact && state.path !== null && titled ? (
      <Text
        role="heading"
        aria-level={1}
        style={styles.inlineTitle}
        testID="note-inline-title"
      >
        {noteHeading(state.draft, state.path)}
      </Text>
    ) : null}

    {/* Who moved it to the trash, and when: one quiet line, no box. */}
    {trashed === undefined ? null : (
      <TrashedByline
        trashed={trashed}
        viewer={commenter}
        style={compact ? styles.trashedBylineCompact : [styles.trashedBylinePointer, { marginHorizontal: noteGutterFor(docWidth) }]}
      />
    )}

    {/*
      **A note you cannot edit is still a note.**

      This used to branch on `editable`, with a phone carved out as the one
      exception: anything read-only on a *pointer* layout fell through to a
      syntax-highlighted source view below — monospace, with its `#` and `**`
      showing. That was a reasonable *inspector*, and it was reaching people
      it was never meant for. `browser.ts` is explicit that `canEdit: false`
      is a signed-in workspace **member**, not a landing-page visitor, so
      every note in a context somebody was invited into as a viewer was read
      as raw Markdown in a code face — on a pointer, while the identical note
      already got Live Preview on a phone. Two answers to "what does this
      file look like", R2 in the editor-polish sweep.

      The reading surface is the same one everywhere now, with editing
      switched off: `LiveEditor` already takes `editable`, CodeMirror's own
      `contenteditable` goes with it, and the live-preview decorations do not
      care. So a member reads what an editor reads, which is what Obsidian's
      reading view is — on every density, which is the finish this comment
      used to describe as future work. The raw-source `ScrollView` this
      replaced, and the styles it alone used, are gone rather than kept
      dark: a renderer nothing reaches is a second one to keep in step with
      every future change to the first, which is exactly how this drifted.
    */}
    {noteDocument(view)}

    {/* A routine's recent runs, after the note's last line on a phone (`routines/RecentRuns.tsx`). */}
    {compact ? <RecentRunsSection where="below" gutter={layout.readingMargin} /> : null}
    {/* Room for the phone's Restore, so the last line scrolls out from under it. */}
    {compact && trashed !== undefined ? <View style={{ height: RESTORE_BAR_ROOM }} /> : null}

    <Reveal open={state.status === "conflict"}>
    {state.status === "conflict" ? (
      <View style={styles.conflict}>
        <Text variant="hint" style={styles.conflictText}>
          {state.message} Your draft is still here — nothing has been overwritten.
        </Text>
        <View style={styles.conflictActions}>
          <Button label="Load theirs" onPress={onUseTheirs} />
          <Button label="Keep mine" onPress={onKeepMine} />
        </View>
      </View>
    ) : null}
    </Reveal>

    {/*
      The durability line, and it is not chrome.

      **This sentence is the product's whole promise in five words, so the
      one thing it may never do is be wrong.** Three states reach it and each
      has to say something different and true: a note that is in the bucket
      says so, a queued draft says it is written down on this device, and a
      body served from the read cache says it came off this device.
      `statusLine` below is where that is decided, and it prints nothing at
      all rather than fall through to the reassuring default.

      **It is the phone's, and that is a reversal of a reversal.** It was
      pointer-only once, on the argument that a permanent 26pt strip is a
      band of chrome across the bottom of a phone that already has a floating
      toolbar lying on it; that argument was about a *strip*, and the phone's
      note stopped being one — it is a single full-bleed scroller, so this is
      the last line of the document rather than a bar pinned under it, it
      scrolls with the text, and the content padding at the foot brings it
      out from under the toolbar. All of that still holds, so the sentence
      stays here at compact.

      What changed is the other density, twice. A pointer layout had the
      status bar, and `status.ts`'s `save` segment was **the same claim**:
      "Saved", "Saved 2 minutes ago", "Cached copy", "Queued", "Not saved".
      Measured in Chromium at 1440×900: "Saved in your bucket" sat 40pt above
      the word "Saved", at the same leading edge, in two visual languages —
      so the sentence went compact-only and the bar, the surface that never
      moves, kept the claim.

      The claim has since moved again, to the top bar's `SaveMark`, and this
      sentence came part of the way back with it. It is drawn at a pointer
      width in exactly the states `decision` names — a failed save, a
      conflict, a queued draft — because in those the sentence is not a
      restatement of the chip but the thing the chip has no room for: "Still
      waiting on your bucket, so we stopped waiting…" is a paragraph, and
      "Not saved" is two words. Everywhere else the chip says it alone and
      nothing stands over the note.

      Discard sits beside it, at every density. It has no other route on a
      phone: the row menu acts on a file in the tree, and this acts on the
      draft in front of you.
    */}
    {/*
      Three things can put this row on screen and each is asked for
      separately, which is the bug the first draft of the compact-only rule
      shipped: gating the whole row on the sentence took the Save button —
      and, in a conflict, Overwrite theirs — off every pointer layout with it,
      because the row is where that button lives.
    */}
    {/* Eased rather than popped: on a pointer layout this row arriving on its own (a failed save, a conflict) shrinks the editor from below. */}
    {/* Not under a note in the trash: "Saved in your bucket" is not what it is. */}
    <Reveal open={trashed === undefined && Boolean(explains || canDiscard || manualSave)}>
    {trashed === undefined && (explains || canDiscard || manualSave) ? (
      <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
        {/*
          Absent rather than empty. `statusLine` answers `""` for a state it
          has no true sentence for — an empty editor, a queued draft whose
          message never arrived — and an empty `Text` here would be a blank
          line where a claim is supposed to be.
        */}
        {!explains ? null : (
          <Text variant="meta" style={styles.status} testID="note-durability">
            {durability}
          </Text>
        )}
        {/* The two states it is offered in, and why, are beside `canDiscard`. */}
        {canDiscard ? <Button label="Discard changes" onPress={onDiscard} /> : null}
        {/*
          Save is on the bottom toolbar on a phone — `check`, which dims when
          there is nothing to save and carries a dot when there is — so
          drawing it again here is two Save buttons on a 390pt screen, one of
          them under the reader's thumb and one not.

          Discard is *not* dropped with it. It has no other route on a phone:
          the row menu acts on a file in the tree, and this acts on the draft
          in front of you. A control removed because its neighbour was
          duplicated is a capability lost to a layout decision.

          **And it is drawn only when pressing it does something**, which is
          the second half of the same argument one form factor over. Measured
          in a browser at 1440×900: a resting note carried the sentence
          "Saved in your bucket" at the leading edge of this row and a dimmed
          pill reading "Saved" at the trailing edge of it — the same claim,
          twice, in two visual languages, at opposite ends of one row. A
          phone drew the sentence alone. So the wider the window, the more
          ways the console found to say one thing, and the second of them
          reads as an unstyled placeholder rather than as status.

          `editor.ts` already says which half is which: the pill exists
          because "a save that failed and a conflict are exactly the cases
          autosave refuses, so the manual route has to stay reachable" — a
          statement about the states it can be **pressed** in. In every other
          state it is disabled, and in every one of those the sentence beside
          it has already said the same thing in words it can say more
          truthfully: "Saved in your bucket" over "Saved", a queued draft's
          own message over "Queued", and — for `Read-only` and `Encrypted` —
          the notice at the head of the note rather than one word at the foot
          of it.

          So `button.disabled` decides whether this is drawn rather than how
          it looks — **and `decision` decides it too**, which is the later
          half of the same argument. `dirty` is a pressable arm of
          `saveButton` and it is no longer drawn here: autosave writes that
          draft a couple of seconds after typing stops, ⌘S writes it now, and
          a button that appears under somebody's hands on every keystroke to
          offer what is already happening is the app asking to be looked
          after. What is left is `error` and `conflict` — the two states
          autosave refuses, where `editor.ts` says the manual route has to
          stay reachable, and where nothing else on screen will make the
          write.
        */}
        {!manualSave ? null : (
          <Button
            label={button.label}
            variant={state.status === "conflict" ? "danger" : "white"}
            onPress={onSave}
          />
        )}
      </View>
    ) : null}
    </Reveal>
  </>
  );
}
