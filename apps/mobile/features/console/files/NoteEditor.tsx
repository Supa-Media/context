import { useRef, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { accessoryUp } from "./accessory";
import { saveButton, type EditorState } from "./editor";
import { splitNote } from "./frontmatter";
import { LiveEditor, type EditorControls } from "./LiveEditor";
import { NoteAccessory } from "./NoteAccessory";
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
 * On native it is the same editor. CodeMirror is a DOM library, so `LiveEditor.tsx`
 * runs it inside a `WebView` over a five-message JSON bridge — one editor
 * configuration (`editorSetup.ts`), two hosts, one bundle committed and shipped
 * with the app so a note opens with no network at all. This comment used to say
 * the native half was a textarea and that the gap was deliberate; see
 * `LiveEditor.tsx` for which halves of that argument expired and which one
 * (a `TextInput` cannot hide a range of its own value) is why it is a web view
 * rather than a second editor.
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
 *
 * ## The keyboard accessory bar, and the three conditions it appears under
 *
 * While the keyboard is up on a phone it covers the bottom bar, so the app has
 * no controls at all — including no way to put the keyboard away, because the
 * editor is a `WebView` with its outer scroller switched off and there is no
 * drag-to-dismiss to fall back on. `NoteAccessory` is the answer, and
 * `accessoryUp` holds the three conditions it renders under; the same call
 * decides how much of the note `LiveEditor` has to keep clear for it.
 *
 * ## And the frontmatter, which is split for display and never for storage
 *
 * A captured note opens with a dozen lines of YAML, and this editor draws the
 * file, so on a phone that block *is* the first screen. The editor is therefore
 * handed the body alone at `compact`, and the exact prefix `splitNote` removed
 * is put back in front of every edit before it reaches `onChange`.
 * `frontmatter + body === draft` holds for every input by construction — which
 * is what makes a save return the file byte for byte — and it holds for a key
 * on the accessory bar exactly as for a keystroke, because a command's effect
 * leaves `LiveEditor` through the same `onChange`.
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
  /*
    The accessory bar's two inputs. `focused` is state because it decides what
    renders; the handle is a ref because it decides nothing — re-rendering the
    whole note the moment the editor hands its commands over would be a render
    for no visible change, on the mount that is already the most expensive one.
  */
  const [focused, setFocused] = useState(false);
  const controls = useRef<EditorControls | null>(null);
  const barUp = accessoryUp({ compact, editable, focused });
  /*
    Split for display, never for storage. `frontmatter` is the exact prefix
    `splitNote` removed, so re-attaching it on every edit reassembles the
    original bytes. See the file comment.
  */
  const { frontmatter, body } = splitNote(state.draft);

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
          /*
            The body alone on a phone, and the whole file everywhere else.

            **The file is not changed by this.** See the file comment:
            `frontmatter + body === state.draft` by construction, so
            re-attaching on every edit reassembles the original bytes and a save
            writes `state.draft` untouched, exactly as it always did.

            It also does not fight either editor. Both write an incoming `value`
            into themselves only when it differs from what they already hold, and
            after a keystroke it does not — the parent re-splits the very draft
            the editor just produced. No dispatch, so no caret jump.
          */
          value={compact ? body : state.draft}
          editable={editable}
          /*
            The accessory bar's keys go out through *this* `onChange`, which is
            the whole reason they are the editor's own commands rather than
            string surgery in the bar: pressing B on a phone has to re-attach
            the frontmatter exactly as typing a character does.
            `noteAccessory.test.ts` presses B and asserts the YAML block is
            still in front of what arrives.
          */
          onChange={compact ? (next) => onChange(frontmatter + next) : onChange}
          onSave={onSave}
          controls={(api) => {
            controls.current = api;
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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
          {state.status === "dirty" || state.status === "error" ? (
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

      {/*
        Last, and a sibling of everything above rather than a child of any of
        it. `KeyboardSticky` positions this absolutely against its parent, so
        inside a scroller it would anchor to the bottom of the *document* and
        scroll away with it; here it anchors to the note's region and rides
        above the keyboard, which is the whole job.

        See the file comment for the three conditions, and `LiveEditor.tsx` for
        why this bar is the only way out of the keyboard rather than one of two.
      */}
      {barUp ? <NoteAccessory controls={() => controls.current} /> : null}
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
    case "saved":
    case "error":
      return state.message ?? "";
    case "conflict":
      return "Conflict";
    default:
      return "Saved in your bucket";
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
