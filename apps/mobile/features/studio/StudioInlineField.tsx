import { useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, type StyleProp, type TextStyle } from "react-native";
import { pointerType, radii, space } from "../design/tokens";
import { useFieldFont } from "../design/fieldFont";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * Words on the script rail that are typed over where they stand (Dev2,
 * 2026-09-30: "allow inline text editing of the script"). It reads as text
 * until pressed; Enter or leaving it keeps the words, Escape puts them back.
 * The note changes once, when the words are kept, not on every letter.
 *
 * While it is not being typed in it follows the note, so an agent's change to
 * the same words shows at once; while it is, the typing wins until it is kept.
 */
export function StudioInlineField({
  value,
  onCommit,
  label,
  style,
  testID,
  width,
}: {
  value: string;
  /** Keeps the words; not called when they are unchanged. */
  onCommit: (words: string) => void;
  label: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
  /** A fixed width, for a short field such as a pause's seconds. */
  width?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const phone = useFieldFont(pointerType.ui);
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const keep = () => {
    const words = draft.trim();
    if (words !== value.trim()) onCommit(words);
    else setDraft(value);
  };
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
        if (cancelled.current) setDraft(value);
        else keep();
      }}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") {
          cancelled.current = true;
          (event.target as unknown as { blur?: () => void }).blur?.();
        }
      }}
      blurOnSubmit
      accessibilityLabel={label}
      style={[styles.field, editing ? styles.editing : null, width === undefined ? styles.grow : { width }, style, phone]}
      testID={testID}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: {
      minHeight: 30,
      paddingHorizontal: space.x2,
      paddingVertical: 4,
      marginLeft: -space.x2,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: "transparent",
      color: colors.text,
      fontSize: pointerType.ui,
      lineHeight: 20,
    },
    editing: { borderColor: colors.accent, backgroundColor: colors.surface },
    grow: { flex: 1, minWidth: 0 },
  });
