import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, TextInput, type StyleProp, type TextStyle } from "react-native";
import { useFieldFont } from "../../design/fieldFont";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * A note's name, as a field that reads as text until somebody clicks it.
 *
 * Click, type, and Enter or clicking away renames; Escape puts the name back
 * (`noteName.ts` says what the typed words become). The breadcrumb's leaf and
 * a title-less note's inline title are both this, so the two ways to rename a
 * note from the note behave the same.
 *
 * Controlled only while it has focus. Out of focus it shows `name`, which the
 * caller derives from the path and the rename in flight — so a rename the
 * bucket refuses, or one `rename` turns down with a notice, leaves the field
 * reading the name the note really has rather than the one that was typed.
 */
export function NameField({
  name,
  onCommit,
  fontSize,
  fit = false,
  style,
  label,
  testID,
}: {
  name: string;
  /** The typed words, when they differ from `name`. */
  onCommit: (typed: string) => void;
  /** Its type size, which a phone raises to 16 so Safari does not zoom. */
  fontSize: number;
  /**
   * As wide as the name rather than as wide as the row: a breadcrumb's leaf
   * sits in a line with things after it. Measured in `ch`, which is exact for
   * the monospace the path line is set in.
   */
  fit?: boolean;
  style?: StyleProp<TextStyle>;
  label: string;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const phone = useFieldFont(fontSize);
  const [draft, setDraft] = useState(name);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!focused.current) setDraft(name);
  }, [name]);
  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onFocus={() => {
        focused.current = true;
        cancelled.current = false;
        setEditing(true);
      }}
      onBlur={() => {
        focused.current = false;
        setEditing(false);
        const typed = draft.trim();
        if (!cancelled.current && typed !== "" && typed !== name) onCommit(typed);
        setDraft(name);
      }}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") {
          cancelled.current = true;
          (event.target as unknown as { blur?: () => void }).blur?.();
        }
      }}
      // One line: Return is the commit, never a newline in a file name.
      multiline={false}
      blurOnSubmit
      returnKeyType="done"
      autoCorrect={false}
      spellCheck={false}
      selectTextOnFocus
      placeholder="Name this note"
      placeholderTextColor={colors.muted}
      accessibilityLabel={label}
      style={[styles.field, { fontSize }, fit ? fitWidth(draft) : null, editing ? styles.editing : null, style, phone]}
      testID={testID}
    />
  );
}

function fitWidth(text: string): TextStyle | null {
  // `ch` is a CSS unit; a native field sizes to its text by itself.
  if (Platform.OS !== "web") return null;
  // A character to spare for the caret at the end of the name.
  return { width: `${Math.max(text.length, 4) + 1}ch` as unknown as number, maxWidth: "100%" };
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: {
      color: colors.text,
      padding: 0,
      borderRadius: 4,
      // RN Web draws a focus ring on a field; the caret and the tint say
      // this is being edited. See `MeetingTitleField`.
      outlineWidth: 0,
      minWidth: 0,
    },
    editing: { backgroundColor: colors.surface2 },
  });
