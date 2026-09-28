/**
 * The Board view of a project (the approved artboard): a slim **Backlog
 * rail** at the left, then one column per status — To do, In progress,
 * Finished by default — each headed in its group's tint, so the order is the
 * same whatever the folder's words are (`boardLayout.ts`). Every status in
 * the folder's list is a column even while nothing is in it, and a word
 * nobody placed asks for its group in its own column's head. It draws tasks
 * only: a note with no status is not a card.
 *
 * The rail says how many are parked and takes a dropped card, which parks it
 * (its status becomes the list's Backlog word, the write any column drop
 * makes). Pressed, it opens into a column of its cards and folds back again.
 * A list with no Backlog word has no rail. A long Done column shows its
 * newest few and "Show N more".
 *
 * Moving a card is its status value (`BoardCard.tsx`): a drag with a
 * pointer, or its status button. Either way the card moves at once and comes
 * back, with the reason, if the write is refused. The columns scroll sideways
 * when they outgrow the page, on a phone as on a desktop.
 */

import { Platform, StyleSheet, ScrollView, Pressable, View, type TextStyle } from "react-native";
import { useState, type ReactNode } from "react";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { BoardCard } from "./BoardCard";
import { boardLayout } from "./boardLayout";
import { useColumnDrop } from "./boardDrag";
import { ChooseGroup } from "./ChooseGroup";
import type { ItemActions } from "./items";
import { dropValue, type FolderGroup } from "./model";
import type { StatusBand } from "./statuses";
import { toneColor, type StatusTone } from "./StatusPill";

/** A column's width at rest; columns narrow to `BOARD_COLUMN_MIN` before the board scrolls. */
export const BOARD_COLUMN = 240;
const BOARD_COLUMN_MIN = 200;
const RAIL = 56;
/** Cards a Done column shows before "Show N more". */
const DONE_SHOWN = 5;

export function FolderBoard({
  bands,
  compact,
  now,
  actions,
}: {
  bands: readonly StatusBand[];
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [dragging, setDragging] = useState<string | null>(null);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const edit = actions.onChoose;
  const { backlog, columns } = boardLayout(bands);
  const all = bands.flatMap((band) => band.columns.flatMap((column) => column.items));
  const drop = (path: string, column: string) => {
    setDragging(null);
    const item = all.find((each) => each.path === path);
    if (item === undefined || edit === null) return;
    const value = dropValue(item, column);
    if (value !== undefined) edit(item, "status", value);
  };
  const shared = { compact, now, actions, dragging, onLift: setDragging, canMove: edit !== null };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.columns} testID="folder-board">
      {backlog === null ? null : backlogOpen ? (
        <Column
          {...shared}
          group={backlog}
          tone="not-started"
          onDrop={(path) => drop(path, backlog.value)}
          testID="folder-board-backlog"
          end={
            <Pressable onPress={() => setBacklogOpen(false)} role="button" accessibilityLabel="Fold Backlog away" hitSlop={8} testID="folder-board-backlog-close">
              <Icon name="close" size={13} />
            </Pressable>
          }
        />
      ) : (
        <Rail group={backlog} canMove={edit !== null} onDrop={(path) => drop(path, backlog.value)} onOpen={() => setBacklogOpen(true)} />
      )}
      {columns.map(({ group, tone }) => (
        <Column
          key={group.value.toLowerCase()}
          {...shared}
          group={group}
          tone={tone}
          onDrop={(path) => drop(path, group.value)}
          testID="folder-board-column"
          end={
            tone === "unplaced" && actions.onPlaceStatus !== null ? (
              <ChooseGroup word={group.value} onPlace={actions.onPlaceStatus} onEditList={actions.onEditStatuses} />
            ) : null
          }
        />
      ))}
    </ScrollView>
  );
}

/** Backlog, folded: its count and name down a slim rail, and somewhere to drop a card to park it. */
function Rail({ group, canMove, onDrop, onOpen }: { group: FolderGroup; canMove: boolean; onDrop: (path: string) => void; onOpen: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [over, setOver] = useState(false);
  const ref = useColumnDrop({ enabled: canMove, onOver: setOver, onDrop });
  return (
    <Pressable
      ref={ref as never}
      onPress={onOpen}
      role="button"
      aria-expanded={false}
      accessibilityLabel={`${group.label}, ${group.items.length}`}
      style={[styles.rail, over && styles.railOver]}
      testID="folder-board-rail"
    >
      <Text variant="rowTitle" style={{ color: colors.accentText }}>
        {String(group.items.length)}
      </Text>
      <Text variant="meta" numberOfLines={1} style={[Platform.OS === "web" && styles.railWord, { color: colors.accentText }]}>
        {Platform.OS === "web" ? `${group.label}: ideas and later work` : group.label}
      </Text>
    </Pressable>
  );
}

function Column({
  group,
  tone,
  compact,
  now,
  actions,
  canMove,
  dragging,
  onLift,
  onDrop,
  end,
  testID,
}: {
  group: FolderGroup;
  tone: StatusTone;
  compact: boolean;
  now: number;
  actions: ItemActions;
  canMove: boolean;
  dragging: string | null;
  onLift: (path: string | null) => void;
  onDrop: (path: string) => void;
  /** Drawn at the end of the head: Choose group for a word nobody placed, or folding Backlog away. */
  end: ReactNode;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ref = useColumnDrop({ enabled: canMove, onOver: setOver, onDrop });
  const empty = group.items.length === 0;
  const done = tone === "done";
  const shown = done && !showAll ? group.items.slice(0, DONE_SHOWN) : group.items;
  const hidden = group.items.length - shown.length;
  const tint = tone === "not-started" ? colors.muted : toneColor(colors, tone);
  return (
    <View ref={ref as never} style={[styles.column, compact && styles.columnTouch]} testID={testID} aria-label={`${group.label}, ${group.items.length}`}>
      <View style={[styles.head, { borderBottomColor: tone === "not-started" ? colors.lineStrong : tint }]}>
        <Text variant="tree" numberOfLines={1} style={[styles.headLabel, { color: tint }]}>
          {group.label}
        </Text>
        <Text variant="tree" style={styles.count}>
          {String(group.items.length)}
        </Text>
        {end === null ? null : <View style={styles.headEnd}>{end}</View>}
      </View>
      <View style={[styles.cards, over && styles.cardsOver, dragging !== null && empty && styles.cardsWaiting]}>
        {shown.map((item) => (
          <BoardCard
            key={item.path}
            item={item}
            now={now}
            actions={actions}
            compact={compact}
            done={done}
            lifted={dragging === item.path}
            onLift={(lifted) => onLift(lifted ? item.path : null)}
          />
        ))}
        {hidden > 0 ? (
          <Pressable onPress={() => setShowAll(true)} role="button" style={styles.more} testID="folder-board-more">
            <Text variant="tree" style={styles.count}>
              {`Show ${hidden} more`}
            </Text>
          </Pressable>
        ) : null}
        {empty ? (
          <Text variant="meta" style={styles.empty} testID="folder-board-empty">
            {canMove && dragging !== null ? "Drop here" : "Nothing here"}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    columns: { flexGrow: 1, flexDirection: "row", gap: space.x4, paddingBottom: space.x2 },
    rail: {
      width: RAIL,
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x4,
      borderRadius: radii.card,
      borderWidth: 1.5,
      borderStyle: "dashed",
      borderColor: colors.accent,
      backgroundColor: colors.chipFill,
      overflow: "hidden",
    },
    railOver: { backgroundColor: colors.surface3 },
    // Down the rail, read bottom to top, as a spine is: a browser sets the words on their side; a phone says the one word.
    railWord: { writingMode: "vertical-rl", transform: [{ rotate: "180deg" }], letterSpacing: 0.4 } as unknown as TextStyle,
    column: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: BOARD_COLUMN_MIN, maxWidth: BOARD_COLUMN + 40 },
    columnTouch: { flexGrow: 0, flexBasis: "auto", width: 264, minWidth: 264, maxWidth: 264 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 32, paddingBottom: space.x2, borderBottomWidth: 2 },
    headLabel: { flexShrink: 1, fontWeight: "600" },
    count: { color: colors.chromeMuted },
    headEnd: { marginLeft: "auto" },
    // A column is a drop target down its whole height, not only where its cards end.
    cards: { gap: space.x2, marginTop: space.x2, minHeight: 64, padding: 2, borderRadius: radii.card, borderWidth: 1, borderColor: "transparent" },
    cardsOver: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },
    cardsWaiting: { borderColor: colors.line, borderStyle: "dashed" },
    empty: { color: colors.chromeMuted, paddingVertical: space.x3, textAlign: "center" },
    more: { paddingVertical: space.x2, paddingHorizontal: space.x1 },
  });
