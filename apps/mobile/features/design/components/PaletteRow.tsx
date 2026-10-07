import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { MEANING_ONLY_LABEL, type Match, type PaletteItem } from "../../console/files/palette";
import { space } from "../tokens";
import { useColors, useThemedStyles, type Colors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

/**
 * The palette's one row, drawn by both of its presentations — see
 * `Palette.tsx`, "Two presentations, one row", for why there is exactly one.
 * Split out of it whole, with the measures the list's scroll arithmetic reads.
 */

/** A pointer row: one line, detail right-aligned. */
export const POINTER_ROW_HEIGHT = 38;

/**
 * A touch row: label over detail, and never below the 44pt minimum target.
 * 56 rather than exactly 44 because this list is scrolled with the same thumb
 * that taps it, and 44 back-to-back rows are 44 chances to open the wrong note.
 */
export const TOUCH_ROW_HEIGHT = 56;

/** `kind` as one character. Cheaper than an icon set and legible at 10px. */
const GLYPHS: Readonly<Record<PaletteItem["kind"], string>> = {
  note: "▢",
  folder: "▸",
  command: "⌘",
};

/**
 * `kind` on a phone: the icons Home's rows draw, at Home's size (board 04).
 * The glyphs above read as tiny empty boxes at a thumb's distance (owner's
 * retest, 2026-10-01).
 */
const ICONS: Readonly<Record<PaletteItem["kind"], IconName>> = {
  note: "file",
  folder: "folder",
  command: "sparkle",
};

/* -------------------------------------------------------------------------- */
/*                                    rows                                    */
/* -------------------------------------------------------------------------- */

interface Run {
  text: string;
  matched: boolean;
}

/**
 * `label` cut into matched and unmatched runs.
 *
 * `ranges` are half-open `[start, end)` slices of `label`, ascending and
 * non-overlapping — that is the contract `fuzzyMatch` documents — so this is a
 * single pass with a cursor. Anything left after the last range is the tail,
 * and an empty `ranges` (the untyped palette) yields the whole label unmatched.
 */
export function highlightRuns(
  label: string,
  ranges: readonly (readonly [number, number])[],
): Run[] {
  const runs: Run[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) runs.push({ text: label.slice(cursor, start), matched: false });
    if (end > start) runs.push({ text: label.slice(start, end), matched: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < label.length) runs.push({ text: label.slice(cursor), matched: false });
  return runs;
}

/**
 * The dim line: where the note is, then the words in it that matched —
 * `website · …onboarding, private sharing…`. Either half may be absent. A note
 * found by meaning alone says so between them, because its snippet will not
 * hold the words that were typed.
 */
export function secondLine(item: PaletteItem): string {
  return [item.detail, item.meaningOnly ? MEANING_ONLY_LABEL : undefined, item.snippet]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

/**
 * The one row both presentations draw.
 *
 * The matched runs are their own `Text` nodes because that is the only way to
 * give a slice of a string its own weight in React Native — there is no
 * `<mark>` and no rich-text primitive. Unmatched runs stay bare strings so
 * they inherit the parent's size and colour and cannot fall out of step with it.
 */
export function PaletteRow({
  match,
  selected,
  touch,
  onPress,
  testID,
}: {
  match: Match;
  selected: boolean;
  touch: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const labelVariant = touch ? "treeTouch" : "tree";
  const runs = highlightRuns(match.item.label, match.ranges);
  const second = secondLine(match.item);

  return (
    <Pressable
      role="option"
      aria-selected={selected}
      accessibilityLabel={
        second ? `${match.item.label}, ${second}` : match.item.label
      }
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={[
        styles.row,
        touch ? styles.rowTouch : styles.rowPointer,
        hovered && !selected && styles.rowHover,
        // A phone has no arrow keys to move a picked row, so none is painted.
        selected && !touch && styles.rowSelected,
      ]}
    >
      {touch ? (
        <Icon name={ICONS[match.item.kind]} size={20} color={colors.text2} />
      ) : (
        <Text variant="treeMeta" style={styles.glyph} aria-hidden>
          {GLYPHS[match.item.kind]}
        </Text>
      )}

      <View style={styles.rowText}>
        <Text variant={labelVariant} numberOfLines={1} style={styles.label}>
          {runs.map((run, index) =>
            run.matched ? (
              <Text
                key={`${index}-${run.text}`}
                variant={labelVariant}
                style={styles.mark}
                testID="palette-mark"
              >
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
        </Text>

        {/* Under the label where there is a whole screen, beside it where a
            pointer means the row can afford to be one line tall. */}
        {second && touch ? (
          <Text variant="treeMeta" numberOfLines={1} style={styles.detailUnder} testID="palette-detail">
            {second}
          </Text>
        ) : null}
      </View>

      {second && !touch ? (
        <Text variant="treeMeta" numberOfLines={1} style={styles.detailBeside} testID="palette-detail">
          {second}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x4,
  },
  rowPointer: { height: POINTER_ROW_HEIGHT },
  rowTouch: { height: TOUCH_ROW_HEIGHT, gap: space.x3 },
  rowHover: { backgroundColor: colors.surface2 },
  rowSelected: { backgroundColor: colors.accentDim },
  rowText: { flex: 1, minWidth: 0 },
  glyph: { width: 14, textAlign: "center" },
  label: { color: colors.text2 },
  /** The whole reason `Match.ranges` is carried out of the ranker. */
  mark: { color: colors.text, fontWeight: "600" },
  detailUnder: { marginTop: 1 },
  detailBeside: { maxWidth: "45%", marginLeft: "auto" },
});
