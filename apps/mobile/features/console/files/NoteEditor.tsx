import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { saveButton, type EditorState } from "./editor";
import { LiveEditor } from "./LiveEditor";
import { highlightMarkdown } from "./highlight";

/**
 * The note itself: markdown, drawn as the document it is.
 *
 * This used to say "not a WYSIWYG, on purpose", and the reasoning it gave is
 * still exactly right — the canonical thing in this product is a markdown file
 * the customer owns and also opens in Obsidian, and **an editor that renders
 * something other than the file is an editor that can disagree with it.**
 *
 * What changed is that the rule no longer implies a plain textarea. `LiveEditor`
 * on web is CodeMirror in Obsidian's Live Preview mode: the buffer *is* the
 * markdown, styled where it sits, with the markup hidden only while the cursor
 * is elsewhere. Nothing parses the document into another model and serializes it
 * back, so there is no serializer that could disagree with the file — the
 * property this comment was protecting is stronger now, not weaker. A block
 * editor (Yoopta, TipTap) would have broken it, which is why this is not one.
 *
 * On native `LiveEditor` is the textarea this always was. CodeMirror is a DOM
 * library and the alternatives are worse than the gap; see `LiveEditor.tsx`.
 *
 * Read-only notes (`privacy.md`, and the whole landing-page demo) render as the
 * mockup's tinted preview rather than a disabled editor, because a disabled
 * editor looks broken and a preview looks deliberate.
 *
 * The preview keeps its monospace face at every width, and that is not an
 * oversight in the phone layout beside it: `LiveEditor` grows to reading type
 * on a phone because the thing on screen is a *note*, and the two documents
 * that reach this branch are `privacy.md` — a generated config file, where the
 * mono face is the whole signal that it is one — and the landing page's demo,
 * which is a picture of the console rather than somebody's reading surface.
 * What the preview does drop on a phone is its *box*, for the same reason the
 * editor drops its own: a border around the only thing on the glass.
 */
export function NoteEditor({
  state,
  canEdit,
  onChange,
  onSave,
  onDiscard,
  onUseTheirs,
  onKeepMine,
}: {
  state: EditorState;
  canEdit: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onUseTheirs: () => void;
  onKeepMine: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const editable = canEdit && !state.readOnly;
  const button = saveButton(state);
  const compact = densityFor(useWindowDimensions().width) === "compact";

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {state.readOnly ? <ManifestNotice /> : null}

      {/*
        **A note you cannot edit is still a note.**

        This used to branch on `editable`: anything read-only fell through to
        the syntax-highlighted source below — monospace, with its `#` and `**`
        showing. That is a reasonable *inspector*, and it was reaching people it
        was never meant for. `browser.ts` is explicit that `canEdit: false` is a
        signed-in workspace **member**, not a landing-page visitor, so every
        note in a context somebody was invited into was read as raw Markdown in
        a code face on a phone.

        The reading surface is the same one, with editing switched off:
        `LiveEditor` already takes `editable`, CodeMirror's own `contenteditable`
        goes with it, and the live-preview decorations do not care. So a member
        reads what an editor reads, which is what Obsidian's reading view is.

        The source view survives where it earns its keep — a pointer, where the
        window is wide enough to inspect a file beside the tree that names it,
        and where `previewContentCompact` was never the layout anyway.
      */}
      {editable || compact ? (
        <LiveEditor
          value={state.draft}
          editable={editable}
          onChange={onChange}
          onSave={onSave}
          accessibilityLabel={`${state.path} markdown`}
        />
      ) : (
        <ScrollView
          style={[styles.preview, compact && styles.previewCompact]}
          contentContainerStyle={compact ? styles.previewContentCompact : styles.previewContent}
        >
          <Text variant="code">
            {highlightMarkdown(state.draft).map((span, index) => (
              <Text
                key={index}
                variant="code"
                style={
                  span.tone === "key"
                    ? styles.codeKey
                    : span.tone === "heading"
                      ? styles.codeHeading
                      : undefined
                }
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      )}

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

      {editable ? (
        <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
          <Text variant="meta" style={styles.status}>
            {statusLine(state)}
          </Text>
          {/*
            `queued` gets Discard too, and it is not a nicety. Save is dead in
            that state — the queue already holds the newest text — so without
            this there is no control on the screen that lets somebody change
            their mind about an edit made offline, and the way out is to retype
            the original and wait for it to sync. Pressing it drops the queued
            write as well as the draft; see `discard` in `useFileBrowser`.
          */}
          {state.status === "dirty" || state.status === "error" || state.status === "queued" ? (
            <Button label="Discard changes" onPress={onDiscard} />
          ) : null}
          {/*
            Save is on the bottom toolbar on a phone — `check`, which dims when
            there is nothing to save and carries a dot when there is — so
            drawing it again here is two Save buttons on a 390pt screen, one of
            them under the reader's thumb and one not.

            Discard is *not* dropped with it. It has no other route on a phone:
            the row menu acts on a file in the tree, and this acts on the draft
            in front of you. A control removed because its neighbour was
            duplicated is a capability lost to a layout decision.
          */}
          {compact ? null : (
            <Button
              label={button.label}
              variant={state.status === "conflict" ? "danger" : "white"}
              disabled={button.disabled}
              onPress={onSave}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * `privacy.md` gets an explanation rather than a disabled cursor.
 *
 * Somebody who opens it is trying to find out how sharing works. Telling them
 * where the switch actually is answers that; greying the file out does not.
 */
function ManifestNotice() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Text variant="hint">
        This file is generated from your visibility settings and is read-only here. To
        change what a client can see, use the visibility control beside a file or folder
        in the tree — this file is rewritten to match. Editing{" "}
        <Text variant="hint" style={styles.noticeStrong}>
          visibility:
        </Text>{" "}
        in a note&apos;s own frontmatter changes nothing: frontmatter describes a note,
        this file decides access.
      </Text>
    </View>
  );
}

function statusLine(state: EditorState): string {
  switch (state.status) {
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    /*
      `queued` reads its own message rather than falling through to the resting
      line. That line is "Saved in your bucket", which is precisely the claim a
      queued draft cannot make — the text is written down on this device and the
      bucket has never heard of it.
    */
    case "queued":
    case "saved":
    case "error":
      return state.message ?? "";
    case "conflict":
      return "Conflict";
    default:
      // Same reason, for a body that came off the device rather than out of the
      // bucket. `status.ts` carries how old the copy is; this says only where
      // it came from.
      return state.fromCache === true ? "Read from this device" : "Saved in your bucket";
  }
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: 12, flex: 1, minHeight: 0 },
  /** The document runs to the edges; what padding there is belongs to it. */
  wrapCompact: { gap: 0 },

  preview: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    // No `maxHeight`. It was 360 while this sat in a card on a scrolling page;
    // in a region that cap strands the reader two thirds of the way down a
    // screen with the rest of the note behind a scrollbar that need not exist.
  },
  previewContent: { paddingVertical: 14, paddingHorizontal: 16 },
  previewCompact: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  previewContentCompact: {
    paddingTop: space.x2,
    paddingHorizontal: space.x5,
    paddingBottom: space.x8,
  },
  codeKey: { color: colors.codeKey },
  codeHeading: { color: colors.text, fontWeight: "500" },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  /**
   * One quiet line under the note rather than a bar of controls.
   *
   * It carries the surface colour, which is not decoration: the editor above it
   * is `flex: 1` and clips, so without a fill the row sits directly against a
   * line of the document cut off mid-height, and the two read as one thing
   * overlapping. A painted strip reads as the foot of the region, which is what
   * it is.
   */
  statusRowCompact: {
    paddingHorizontal: space.x5,
    paddingTop: space.x2,
    paddingBottom: space.x2,
    backgroundColor: colors.surface,
  },
  status: { flexGrow: 1, flexShrink: 1 },

  conflict: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnWash,
    gap: 10,
  },
  conflictText: { color: colors.warnText },
  conflictActions: { flexDirection: "row", gap: 10 },

  notice: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  noticeStrong: { color: colors.hintStrong, fontFamily: fonts.mono },
});
