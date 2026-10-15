/**
 * The staff console's tables and list rows.
 *
 * A table on a pointer and a two-line row on a phone, for the roster, the
 * clients, the providers and the events: hairline-ruled rows edge to edge in
 * a flush `Panel`, with the eyebrow voice for the header. Split out of
 * `./AdminKit` as the one cohesive piece of it that every tab uses.
 */

import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";

export interface Column {
  label: string;
  /** Flex weight; a fixed `width` wins where given. */
  flex?: number;
  width?: number;
  align?: "left" | "right";
  /** What the header means, as a tooltip on web and to a screen reader. */
  hint?: string;
  /** Present on a column the table can be sorted by; handed back to `onSort`. */
  sortKey?: string;
}

export type SortDirection = "asc" | "desc";

/**
 * The header row of a pointer-layout table, in the eyebrow voice. Given
 * `onSort`, a column with a `sortKey` is a button, and the one the table is
 * sorted by carries an arrow.
 */
export function TableHead({
  columns,
  sorted,
  onSort,
}: {
  columns: readonly Column[];
  sorted?: { key: string; dir: SortDirection };
  onSort?: (key: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.tr, styles.th]}>
      {columns.map((column) => {
        const active = sorted !== undefined && column.sortKey === sorted.key;
        const arrow = active ? (sorted.dir === "desc" ? " ↓" : " ↑") : "";
        const label = (
          <Text
            variant="eyebrow"
            numberOfLines={1}
            style={[alignText(column), active && styles.sortedLabel]}
            accessibilityLabel={column.hint ? `${column.label}. ${column.hint}` : undefined}
            // RN-Web forwards `title` to the DOM node: the cheapest honest tooltip.
            {...(Platform.OS === "web" && column.hint ? ({ title: column.hint } as object) : null)}
          >
            {column.label}
            {arrow}
          </Text>
        );
        const sortKey = column.sortKey;
        return (
          <View key={column.label} style={cellBox(column)}>
            {onSort && sortKey ? (
              <Pressable
                role="button"
                accessibilityLabel={`Sort by ${column.label}`}
                aria-sort={active ? (sorted.dir === "desc" ? "descending" : "ascending") : undefined}
                onPress={() => onSort(sortKey)}
                testID={`admin-sort-${sortKey}`}
              >
                {label}
              </Pressable>
            ) : (
              label
            )}
          </View>
        );
      })}
    </View>
  );
}

/** One body row; `cells` line up with the head's `columns`. */
export function TableRow({
  columns,
  cells,
  last = false,
  testID,
}: {
  columns: readonly Column[];
  cells: readonly ReactNode[];
  last?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.tr, !last && styles.ruled]} testID={testID}>
      {cells.map((cell, index) => (
        <View key={columns[index]?.label ?? index} style={[cellBox(columns[index]), styles.td]}>
          {cell}
        </View>
      ))}
    </View>
  );
}

function cellBox(column: Column | undefined): ViewStyle {
  const align = column?.align === "right" ? "flex-end" : "flex-start";
  return column?.width !== undefined
    ? { width: column.width, flexShrink: 0, alignItems: align }
    : { flex: column?.flex ?? 1, minWidth: 0, alignItems: align };
}

function alignText(column: Column) {
  return column.align === "right" ? { textAlign: "right" as const } : null;
}

/**
 * A two-line row for a phone, and for short lists at any width: a title, a
 * sub-line, and something on the right.
 */
export function ListRow({
  title,
  sub,
  extra,
  trailing,
  below,
  first = false,
  testID,
}: {
  title: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  trailing?: ReactNode;
  /** Full width under the title and the trailing figure — a sparkline. */
  below?: ReactNode;
  first?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View
      style={[
        styles.listRow,
        compact && styles.listRowCompact,
        below ? styles.wrap : null,
        !first && styles.ruledTop,
      ]}
      testID={testID}
    >
      <View style={styles.listMain}>
        {typeof title === "string" ? (
          <Text variant="rowTitle" style={compact ? styles.listTitleCompact : null}>
            {title}
          </Text>
        ) : (
          title
        )}
        {sub ? (
          typeof sub === "string" ? (
            <Text variant="meta" style={compact ? styles.listSubCompact : null}>
              {sub}
            </Text>
          ) : (
            sub
          )
        ) : null}
        {extra}
      </View>
      {trailing}
      {below ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

/** A figure on the right of a list row. */
export function RowValue({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.rowValue}>{children}</Text>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tr: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x5,
    },
    th: { paddingVertical: space.x2, borderBottomWidth: 1, borderBottomColor: colors.line },
    sortedLabel: { color: colors.text },
    td: { paddingVertical: 11, justifyContent: "center" },
    ruled: { borderBottomWidth: 1, borderBottomColor: colors.line },

    listRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x3,
      paddingHorizontal: space.x5,
    },
    listRowCompact: { paddingHorizontal: space.x4 },
    below: { flexBasis: "100%", marginTop: -space.x1 },
    ruledTop: { borderTopWidth: 1, borderTopColor: colors.line },
    wrap: { flexWrap: "wrap", rowGap: space.x2 },
    listMain: { flex: 1, minWidth: 0, gap: 2 },
    listTitleCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4) },
    listSubCompact: { fontSize: pointerType.ui },
    rowValue: {
      fontSize: pointerType.lede,
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
  });
