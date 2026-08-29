import { ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, fonts, radii } from "../../design/tokens";
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
  const editable = canEdit && !state.readOnly;
  const button = saveButton(state);

  return (
    <View style={styles.wrap}>
      {state.readOnly ? <ManifestNotice /> : null}

      {editable ? (
        <LiveEditor
          value={state.draft}
          editable
          onChange={onChange}
          onSave={onSave}
          accessibilityLabel={`${state.path} markdown`}
        />
      ) : (
        <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
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
        <View style={styles.statusRow}>
          <Text variant="meta" style={styles.status}>
            {statusLine(state)}
          </Text>
          {state.status === "dirty" || state.status === "error" ? (
            <Button label="Discard changes" onPress={onDiscard} />
          ) : null}
          <Button
            label={button.label}
            variant={state.status === "conflict" ? "danger" : "white"}
            disabled={button.disabled}
            onPress={onSave}
          />
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

const styles = StyleSheet.create({
  wrap: { gap: 12, flex: 1, minHeight: 0 },

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
  codeKey: { color: colors.codeKey },
  codeHeading: { color: colors.text, fontWeight: "500" },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
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
