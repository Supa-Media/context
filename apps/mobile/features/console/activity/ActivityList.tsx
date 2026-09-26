import { View, StyleSheet } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  markFor,
  relativeWhen,
  rowText,
  rows,
  targetOf,
  type ActivityEntry,
  type ActivityMark,
} from "./activity";

/**
 * The list of what changed, drawn once and used in both places it appears.
 *
 * The popover over the file tree and `activity.md` opened as a page are the
 * same rows at two widths — so they are the same component, and the only thing
 * either of them decides is how much room it has. Two copies of a row is two
 * places for the privacy filter's output to be drawn differently.
 *
 * ## Hue is spent on one thing
 *
 * The marks are `chromeMuted`, every one of them, and the only colour in the
 * list is the unread line's petrol. `docs/decisions/app-and-console.md` rations
 * hue by meaning, and "a note was revised" is not a status: a list where every
 * row is a different colour is a list where the one row that matters cannot be
 * found. The kind is carried by the glyph and by the sentence.
 */

/**
 * A mark per kind, from the set the console already draws.
 *
 * `sparkle` for a saved session because that is this product's mark for an AI
 * client's own work everywhere else, and a session is exactly that; `eye` for a
 * widening because the visibility control it mirrors is drawn with the same
 * glyph.
 */
const MARKS: Record<ActivityMark, IconName> = {
  added: "plus",
  revised: "pencil",
  moved: "exchange",
  archived: "collapse",
  published: "eye",
  meeting: "mic",
  session: "sparkle",
};

export function ActivityList({
  entries,
  seenAt,
  now,
  onOpen,
  empty,
  undoFor,
}: {
  entries: readonly ActivityEntry[];
  /**
   * The way back for a row somebody can take back — auto-organize's own
   * changes. Absent, or `undefined` for a row, draws the row as it always was.
   */
  undoFor?: (entry: ActivityEntry) => (() => void) | undefined;
  /** When this reader last caught up, or `null` for never. */
  seenAt: number | null;
  /**
   * Passed in rather than read from the clock here.
   *
   * Every relative time on screen has to agree — "4 min" beside "Today" beside
   * "since you looked" — and three components each calling `Date.now()` during
   * one render produce three different nows. It also makes every one of these
   * rules testable without faking a clock.
   */
  now: number;
  /** Open the note a row is about. Rows about folders do not call it. */
  onOpen: (path: string) => void;
  /** What to say when there is nothing. Never an empty box — see `emptyLine`. */
  empty: string;
}) {
  const styles = useThemedStyles(sheet);
  const drawn = rows(entries, seenAt, now);

  if (!entries.length) {
    return (
      <View style={styles.empty}>
        <Text variant="hint" style={styles.emptyText}>
          {empty}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {drawn.map((row, index) => {
        if (row.kind === "day") {
          return (
            <View key={`day-${row.label}-${index}`} style={styles.divider}>
              <Text variant="eyebrow" style={styles.dayLabel}>
                {row.label}
              </Text>
              <View style={styles.rule} />
            </View>
          );
        }
        if (row.kind === "unread") {
          return (
            <View key={`unread-${index}`} style={styles.divider}>
              <Text variant="eyebrow" style={styles.unreadLabel}>
                {row.label}
              </Text>
              <View style={styles.unreadRule} />
            </View>
          );
        }
        const entry = row.entry;
        const { title, meta } = rowText(entry);
        const target = targetOf(entry);
        const when = relativeWhen(entry.at, now);
        const undo = undoFor?.(entry);
        return (
          // A wrapper so Undo can be the row's sibling: a button may not hold a button.
          <View key={`entry-${entry.at}-${index}`} style={styles.rowWrap}>
          <PressRow
            accessibilityLabel={
              target === null ? title : `${title}. Open ${target}`
            }
            // A row about a folder move opens nothing, and says so by not
            // being a button: an affordance that does nothing is worse than
            // none, and `role` is what a screen reader reads.
            role={target === null ? "link" : "button"}
            onPress={target === null ? undefined : () => onOpen(target)}
            radius={radii.sm}
            style={styles.row}
            hoverStyle={styles.rowHover}
          >
            <View style={styles.mark}>
              <Icon name={MARKS[markFor(entry)]} size={14} color={styles.markInk.color} />
            </View>
            <View style={styles.body}>
              <Text variant="tree" numberOfLines={2} style={styles.title}>
                {title}
              </Text>
              <Text
                variant="treeMeta"
                numberOfLines={1}
                style={[styles.meta, undo === undefined ? null : styles.metaBesideUndo]}
              >
                {meta}
              </Text>
            </View>
            <Text variant="treeMeta" numberOfLines={1} style={styles.when}>
              {when}
            </Text>
          </PressRow>
          {undo === undefined ? null : (
            <PressRow
              accessibilityLabel={`Undo: ${title}`}
              onPress={undo}
              radius={radii.sm}
              style={styles.undo}
              hoverStyle={styles.rowHover}
              testID={`activity-undo-${index}`}
            >
              <Text variant="treeMeta" style={styles.undoText}>
                Undo
              </Text>
            </PressRow>
          )}
          </View>
        );
      })}
    </View>
  );
}

const sheet = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingVertical: space.x1 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    rowHover: { backgroundColor: colors.chipFill },
    mark: { width: 16, paddingTop: 2 },
    markInk: { color: colors.chromeMuted },
    body: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    title: { color: colors.text2 },
    meta: { color: colors.chromeMuted },
    rowWrap: { position: "relative" },
    metaBesideUndo: { paddingRight: 44 },
    undo: {
      position: "absolute",
      right: space.x2,
      bottom: space.x2 - 2,
      paddingHorizontal: space.x1,
      paddingVertical: 2,
    },
    undoText: { color: colors.accentText },
    /*
      `flexShrink: 0` because it is four characters that must not wrap: at 240pt
      the column gave "4 min" two lines and the row grew to fit them. Seen in a
      browser, invisible to jsdom, which lays nothing out.
    */
    when: { color: colors.chromeMuted, paddingTop: 2, flexShrink: 0 },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      paddingTop: space.x3,
      paddingBottom: space.x1,
    },
    dayLabel: { color: colors.chromeMuted },
    unreadLabel: { color: colors.accentText },
    rule: { flexGrow: 1, height: 1, backgroundColor: colors.line },
    unreadRule: { flexGrow: 1, height: 1, backgroundColor: colors.accentDim },
    empty: { padding: space.x4 },
    emptyText: { color: colors.chromeMuted },
  });
