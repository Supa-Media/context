import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { noteHeading } from "../frontmatter";
import { EncryptedNotice, ManifestNotice } from "./notices";
import { noteDocument } from "./document";
import type { NoteView } from "./view";

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
  } = view;
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

      Compact only. A pointer layout still has the breadcrumb, which carries
      folder navigation this cannot, and two names above one note is worse
      than either.

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
    {compact && state.path !== null && titled ? (
      <Text
        role="heading"
        aria-level={1}
        style={styles.inlineTitle}
        testID="note-inline-title"
      >
        {noteHeading(state.draft, state.path)}
      </Text>
    ) : null}

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

      The claim has since moved again, to the top bar's `SaveChip`, and this
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
    {explains || canDiscard || manualSave ? (
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
  </>
  );
}
