/**
 * The editor that replaces a cell while it is being changed, by its type: a
 * date picker, a choice from the column's values or the workspace's people
 * (new values allowed for a select), or a plain field for the rest. Enter and
 * Tab are read by the grid's keyboard handler on the web; on a phone the field's
 * own submit and blur do the same job.
 *
 * It draws no frame of its own: the cell's selection ring is the one outline,
 * as the approved grid has it (a second, inner frame read as a double outline).
 */

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { pointerType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { DateField } from "./DateField";
import { SuggestionMenu } from "./SuggestionMenu";
import type { ColumnType } from "./sheetModel";
import { useFieldFont } from "../../../design/fieldFont";

/** How many choices show at once; the menu scrolls past that. */
const SUGGESTION_LIMIT = 50;
/** A choice editor's blur waits this long for a press on a suggestion before it commits what is typed. */
export const CHOICE_BLUR_MS = 180;

/** Choices a select or person editor offers for what has been typed: every one while the field is empty. */
export function suggestionsFor(choices: readonly string[], draft: string, limit = SUGGESTION_LIMIT): string[] {
  const q = draft.trim().toLowerCase();
  return choices.filter((c) => c.toLowerCase().includes(q) && c.toLowerCase() !== q).slice(0, limit);
}

/** Keys the open editor takes before the grid does: true when it used the key. */
export type EditorKeys = (event: KeyboardEvent) => boolean;

export function CellEditor({
  type,
  label,
  draft,
  choices,
  keys,
  onDraft,
  onPick,
  onBlur,
  onSubmit,
}: {
  type: ColumnType;
  label: string;
  draft: string;
  /** A select's values so far, or the workspace's people. */
  choices: readonly string[];
  /** Filled with this editor's own key handling while it is open. */
  keys?: MutableRefObject<EditorKeys | null>;
  onDraft: (value: string) => void;
  /** A suggestion was chosen: commit it at once. */
  onPick: (value: string) => void;
  /** Commit what is typed when focus leaves. */
  onBlur: () => void;
  onSubmit: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const colors = useColors();
  const web = Platform.OS === "web";
  const anchor = useRef<View | null>(null);
  const isChoice = type === "select" || type === "person";
  const suggestions = isChoice ? suggestionsFor(choices, draft) : [];
  // The suggestion Enter takes: none until an arrow picks one, so a new value can still be typed and kept.
  const [highlight, setHighlight] = useState(-1);
  useEffect(() => setHighlight(-1), [draft]);

  // A choice editor's blur comes before the press on a suggestion lands, so it waits for one.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
  }, []);
  const pick = (value: string) => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
    onPick(value);
  };
  const blur = () => {
    if (!isChoice) return onBlur();
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null;
      onBlur();
    }, CHOICE_BLUR_MS);
  };

  if (keys) {
    keys.current = (event) => {
      if (suggestions.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => Math.max(-1, Math.min(suggestions.length - 1, h + step)));
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && highlight >= 0 && highlight < suggestions.length) {
        pick(suggestions[highlight]);
        return true;
      }
      return false;
    };
  }
  useEffect(
    () => () => {
      if (keys) keys.current = null;
    },
    [keys],
  );

  if (type === "date") {
    return <DateField value={draft} label={label} onChange={onDraft} onBlur={onBlur} onSubmit={onSubmit} />;
  }

  return (
    <View ref={anchor} style={styles.wrap}>
      <TextInput
        autoFocus
        accessibilityLabel={label}
        placeholder={type === "select" ? "Pick or type a new option" : type === "person" ? "Choose a person" : undefined}
        placeholderTextColor={colors.chromeMuted}
        value={draft}
        onChangeText={onDraft}
        onBlur={blur}
        // On the web Enter is read by the grid's keyboard handler, so the field does not also submit.
        onSubmitEditing={web ? undefined : onSubmit}
        // iOS's decimal pad has no minus and no return key.
        keyboardType={type === "number" || type === "usd" ? (Platform.OS === "ios" ? "numbers-and-punctuation" : "decimal-pad") : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        // The browser's squiggle would read as the grid's own misfit mark.
        spellCheck={false}
        style={[styles.input, (type === "number" || type === "usd") && styles.right, fieldFont]}
        testID="sheet-cell-editor"
      />
      <SuggestionMenu anchor={anchor} suggestions={suggestions} highlight={highlight} onPick={pick} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { width: "100%", height: 26 },
    input: {
      height: 26,
      padding: 0,
      paddingHorizontal: 0,
      borderWidth: 0,
      color: colors.text,
      backgroundColor: "transparent",
      fontSize: pointerType.ui,
      outlineStyle: "none",
    } as object,
    right: { textAlign: "right", fontVariant: ["tabular-nums"] } as object,
  });

