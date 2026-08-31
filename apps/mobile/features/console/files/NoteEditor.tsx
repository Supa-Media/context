import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { saveButton, type EditorState } from "./editor";
import { properties, splitNote } from "./frontmatter";
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
  /*
    Split for display, never for storage. `frontmatter` is put back in front of
    every edit before it reaches `onChange`, so what is saved is the file that
    was opened — see the `LiveEditor` call below.
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
        <View style={styles.document}>
          {/*
            The filing metadata, folded away — see `Properties` below and
            `frontmatter.ts`. Only where there is a block to fold: a note
            without one gets no row at all rather than an empty disclosure.
          */}
          {compact && frontmatter !== "" ? <Properties frontmatter={frontmatter} /> : null}
          <LiveEditor
            /*
              The body alone on a phone, and the whole file everywhere else.

              **The file is not changed by this.** `frontmatter` is the exact
              prefix `splitNote` removed, so re-attaching it on every edit
              reassembles the original bytes — `frontmatter + body === draft`
              holds for every input by construction, which is the property
              `frontmatter.ts` is built around and `frontmatter.test.ts` asserts
              over a table. A save writes `state.draft` untouched, exactly as it
              always did.

              It also does not fight CodeMirror on web. That editor writes an
              incoming `value` into itself only when it differs from what it
              already holds, and after a keystroke it does not — the parent
              re-splits the very draft the editor just produced. No dispatch, so
              no caret jump.
            */
            value={compact ? body : state.draft}
            editable={editable}
            onChange={compact ? (next) => onChange(frontmatter + next) : onChange}
            onSave={onSave}
            accessibilityLabel={`${state.path} markdown`}
          />
        </View>
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
    </View>
  );
}

/**
 * The note's filing metadata, folded away.
 *
 * A captured note opens with a dozen lines of YAML — `captured:`, `source:`,
 * `trust:`, `sender-authenticated-by:` — and the editor draws the file, so on a
 * phone that block *was* the first screen. The note started below the fold. It
 * is not secret and it is occasionally worth reading, so it is collapsed rather
 * than hidden: one quiet row that says how many fields there are, and opens.
 *
 * The same shape Obsidian uses, and for the same reason.
 *
 * ## It is a reader, not a form
 *
 * The values are `Text`, not inputs, and there is nothing here that writes.
 * Editing frontmatter means editing the note, which is what the editor below is
 * for and where the buffer is still the file byte for byte. A property editor
 * would need a YAML *writer*, and `frontmatter.ts` argues at length why this
 * codebase should not have one: a reader that misunderstands a line shows it
 * oddly, and a writer that misunderstands the same line rewrites somebody's
 * note into something they did not type.
 *
 * Collapsed is the resting state on purpose. The whole complaint this answers
 * is that metadata was taking the reader's first screen, and a row that starts
 * open takes it back.
 */
function Properties({ frontmatter }: { frontmatter: string }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const rows = properties(frontmatter);

  return (
    <View style={styles.properties}>
      <PressRow
        accessibilityLabel={
          open
            ? `Hide this note's ${rows.length} properties`
            : `Show this note's ${rows.length} properties`
        }
        onPress={() => setOpen((current) => !current)}
        radius={radii.sm}
        style={styles.propertiesHead}
        hoverStyle={styles.propertiesHover}
        testID="note-properties"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.muted} />
        <Text variant="treeMeta">
          {/*
            The count is the whole of what the collapsed row has to say. "1
            property" over "1 properties" because a note with a single field is
            common enough — a bare `updated:` — that the ungrammatical form
            would be on screen most days.
          */}
          {rows.length === 1 ? "1 property" : `${rows.length} properties`}
        </Text>
      </PressRow>

      {open ? (
        <View style={styles.propertyList} testID="note-properties-open">
          {rows.map((row, index) => (
            <View key={`${row.key}-${index}`} style={styles.property}>
              <Text variant="treeMeta" style={styles.propertyKey} numberOfLines={1}>
                {row.key}
              </Text>
              <Text variant="treeMeta" style={styles.propertyValue}>
                {row.value}
              </Text>
            </View>
          ))}
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

  /**
   * The Properties row and the editor under it, as one column.
   *
   * `flex: 1` with `minHeight: 0` so the editor keeps scrolling itself and the
   * row above it keeps its own height rather than being compressed out of
   * existence by a `flex: 1` sibling.
   */
  document: { flex: 1, minHeight: 0 },

  /**
   * A quiet line above the note, at the note's own left margin.
   *
   * `readingMargin` rather than a number of its own: this sits directly above
   * the first line of the document and anything else here would be visibly out
   * of step with it.
   */
  properties: {
    paddingHorizontal: layout.readingMargin,
    paddingTop: space.x1,
    paddingBottom: space.x2,
  },
  propertiesHead: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: layout.minTouchTarget,
    paddingRight: space.x2,
    borderRadius: radii.sm,
  },
  propertiesHover: { backgroundColor: colors.surface3 },
  propertyList: { paddingTop: space.x1, gap: 3 },
  /**
   * Key and value on one line, key first at a fixed measure.
   *
   * A two-column grid is what this wants and what React Native does not have;
   * a fixed leading column is the honest approximation, and the keys in a
   * captured note (`sender-domain`, `authentication-result`) are long enough
   * that a shrink-to-fit column would be a different width on every note.
   */
  property: { flexDirection: "row", alignItems: "flex-start", gap: space.x2 },
  propertyKey: { width: 116, flexGrow: 0, flexShrink: 0 },
  propertyValue: { flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.text2 },

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
    paddingHorizontal: layout.readingMargin,
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
    paddingHorizontal: layout.readingMargin,
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
