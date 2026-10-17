import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WHY_LABEL, type Match, type PaletteItem } from "../../console/files/palette";
import { space } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";
import { POINTER_ROW_HEIGHT, TOUCH_ROW_HEIGHT, highlightRuns } from "./PaletteRow";

/**
 * A search answer's row: its name and reason, then the words from inside it
 * that matched, then where it is and when it was last written (board B1,
 * leadership weekly 2026-10-17).
 *
 * The one-line row put the matched text after the place in a dim run capped
 * at 45% of the width, so the line that says "this is the note" was the one
 * cut to a few words, and a boxed tag sat on every row. Here the text gets two
 * lines of its own, the reason is plain words that count ("Has 2 of 3 words")
 * and only a note found by meaning is coloured.
 *
 * Fixed heights, like `PaletteRow`'s and for its reason: the list scrolls to
 * the highlighted row by arithmetic (`rowTop`), never by measuring.
 */

export const RICH_POINTER_ROW_HEIGHT = 92;
export const RICH_TOUCH_ROW_HEIGHT = 104;

/** A note the search answered with, as opposed to a name, folder or command. */
export function isRich(item: PaletteItem): boolean {
  return item.kind === "note" && item.workspace !== undefined;
}

export function rowHeight(item: PaletteItem, touch: boolean): number {
  if (isRich(item)) return touch ? RICH_TOUCH_ROW_HEIGHT : RICH_POINTER_ROW_HEIGHT;
  return touch ? TOUCH_ROW_HEIGHT : POINTER_ROW_HEIGHT;
}

/** Where row `index` starts in a list of `items`: the scroll arithmetic. */
export function rowTop(items: readonly PaletteItem[], index: number, touch: boolean): number {
  let top = 0;
  for (let at = 0; at < index && at < items.length; at += 1) top += rowHeight(items[at]!, touch);
  return top;
}

/**
 * `text` cut into runs, with every word that starts like one typed marked:
 * "avocado" marks "avocados". Words of one or two letters mark nothing, as
 * they count for nothing in the reason (`queryWords`).
 */
export function wordRuns(text: string, words: readonly string[]): { text: string; matched: boolean }[] {
  const wanted = words.map((word) => word.toLowerCase()).filter((word) => word.length > 2);
  if (wanted.length === 0 || text === "") return text === "" ? [] : [{ text, matched: false }];
  const runs: { text: string; matched: boolean }[] = [];
  // Words and the gaps between them, so a run never splits a word.
  for (const piece of text.split(/([\p{L}\p{N}]+)/u)) {
    if (piece === "") continue;
    const matched = wanted.some((word) => piece.toLowerCase().startsWith(word));
    const last = runs[runs.length - 1];
    if (last !== undefined && last.matched === matched) last.text += piece;
    else runs.push({ text: piece, matched });
  }
  return runs;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "edited today", "edited yesterday", "edited Sep 12", "edited Sep 12, 2025". */
export function editedLabel(ms: number, now: number = Date.now()): string {
  const day = new Date(ms);
  const today = new Date(now);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(today) - start(day)) / 86_400_000);
  if (days <= 0) return "edited today";
  if (days === 1) return "edited yesterday";
  const date = `${MONTHS[day.getMonth()]} ${day.getDate()}`;
  return day.getFullYear() === today.getFullYear() ? `edited ${date}` : `edited ${date}, ${day.getFullYear()}`;
}

/** The place and the date, for the row's last line. */
export function metaLine(item: PaletteItem, now?: number): string {
  return [item.detail, item.edited === undefined ? undefined : editedLabel(item.edited, now)]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

export function PaletteResultRow({
  match,
  words,
  selected,
  touch,
  onPress,
  testID,
}: {
  match: Match;
  /** The words typed, which the snippet bolds. */
  words: readonly string[];
  selected: boolean;
  touch: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const { item } = match;
  // A row the loaded names also found keeps its lit letters; one only the search found bolds the words typed.
  const title = match.ranges.length > 0 ? highlightRuns(item.label, match.ranges) : wordRuns(item.label, words);
  const snippet = wordRuns(item.snippet ?? "", words);
  const reason = item.reason ?? (item.why === undefined ? null : WHY_LABEL[item.why]);
  const meta = metaLine(item);
  const label = touch ? "treeTouch" : "tree";

  return (
    <Pressable
      role="option"
      aria-selected={selected}
      accessibilityLabel={[item.label, reason, item.snippet, meta].filter(Boolean).join(", ")}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={[
        styles.row,
        { height: touch ? RICH_TOUCH_ROW_HEIGHT : RICH_POINTER_ROW_HEIGHT },
        hovered && !selected && styles.hover,
        selected && !touch && styles.selected,
      ]}
    >
      <View style={styles.top}>
        <Text variant={label} numberOfLines={1} style={styles.title}>
          {title.map((run, index) =>
            run.matched ? (
              <Text key={index} variant={label} style={styles.mark} testID="palette-mark">
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
        </Text>
        {reason === null ? null : (
          <Text
            variant="treeMeta"
            numberOfLines={1}
            style={[styles.reason, item.why === "meaning" && styles.meaning]}
            testID="palette-why"
          >
            {reason}
          </Text>
        )}
      </View>
      <Text variant="rowSub" numberOfLines={2} style={styles.snippet} testID="palette-snippet">
        {snippet.map((run, index) =>
          run.matched ? (
            <Text key={index} variant="rowSub" style={styles.snippetMark}>
              {run.text}
            </Text>
          ) : (
            run.text
          ),
        )}
      </Text>
      <Text variant="treeMeta" numberOfLines={1} style={styles.meta} testID="palette-detail">
        {meta}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      paddingHorizontal: space.x4,
      paddingVertical: space.x2,
      justifyContent: "flex-start",
      overflow: "hidden",
    },
    hover: { backgroundColor: colors.surface2 },
    selected: { backgroundColor: colors.accentDim },
    top: { flexDirection: "row", alignItems: "baseline", gap: space.x3, minWidth: 0 },
    title: { flex: 1, minWidth: 0, color: colors.text },
    mark: { color: colors.text, fontWeight: "600" },
    reason: { flexShrink: 0, color: colors.muted },
    meaning: { color: colors.sharedText },
    snippet: { color: colors.text2, marginTop: 1 },
    snippetMark: { color: colors.text, fontWeight: "600" },
    meta: { marginTop: 2 },
  });
