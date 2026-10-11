/**
 * The Board view of a project: a small **Backlog box** above the columns,
 * then one column per status — To do, In progress, Finished by default —
 * each headed in its group's tint, so the order is the same whatever the
 * folder's words are (`boardLayout.ts`). Every status in the folder's list is
 * a column even while nothing is in it, and a word nobody placed asks for its
 * group in its own column's head. It draws tasks only: a note with no status
 * is not a card.
 *
 * The box says how many are parked (owner's pick, 2026-10-11, replacing a
 * full-height rail with sideways words that was hard to read). Pressed, it
 * opens Backlog as the first column, and pressed again folds it away. It takes
 * a dropped card, which parks it (its status becomes the list's Backlog word,
 * the write any column drop makes), and while a card is in the air a tall drop
 * place opens at the left of the columns, so parking never means aiming at a
 * small button. A list with no Backlog word has no box. Where Backlog is a
 * folder (`backlog/` in the page's folder), the box holds what is in it: a
 * card dropped on it moves there, and a parked card dropped on a column moves
 * back out with that column's status (`parked`, `boardLayout.ts`). A long
 * Done column shows its newest few and "Show N more".
 *
 * Moving a card is its status value (`BoardCard.tsx`): a drag with a
 * pointer, or its status button. Either way the card moves at once and comes
 * back, with the reason, if the write is refused. The columns scroll sideways
 * when they outgrow the page, on a phone as on a desktop.
 */

import { StyleSheet, ScrollView, Pressable, View } from "react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { BoardCard } from "./BoardCard";
import { boardLayout, type BoardParked } from "./boardLayout";
import { useColumnDrop } from "./boardDrag";
import { ChooseGroup } from "./ChooseGroup";
import type { ItemActions } from "./items";
import { dropValue, type FolderGroup } from "./model";
import type { StatusBand } from "./statuses";
import { toneColor, type StatusTone } from "./StatusPill";

/** A column's width at rest; columns narrow to `BOARD_COLUMN_MIN` before the board scrolls. */
export const BOARD_COLUMN = 240;
const BOARD_COLUMN_MIN = 200;
/** Cards a Done column shows before "Show N more". */
const DONE_SHOWN = 5;

export function FolderBoard({
  bands,
  compact,
  now,
  actions,
  parked = null,
}: {
  bands: readonly StatusBand[];
  compact: boolean;
  now: number;
  actions: ItemActions;
  /** Where Backlog is a folder: its cards, and the moves in and out of it. */
  parked?: BoardParked | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [dragging, setDragging] = useState<string | null>(null);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const edit = actions.onChoose;
  const board = boardLayout(bands);
  const { columns } = board;
  const backlog: FolderGroup | null =
    parked === null
      ? board.backlog
      : { value: board.backlog?.value ?? "backlog", label: "Backlog", items: [...(board.backlog?.items ?? []), ...parked.items] };
  const all = [...bands.flatMap((band) => band.columns.flatMap((column) => column.items)), ...(parked?.items ?? [])];
  const isParked = (path: string) => parked?.items.some((each) => each.path === path) === true;
  const drop = (path: string, column: string) => {
    setDragging(null);
    const item = all.find((each) => each.path === path);
    if (item === undefined) return;
    // Where Backlog is a folder, the rail moves a card in, and a column moves a parked one out.
    if (parked !== null && backlog !== null && column === backlog.value) {
      if (!isParked(path)) parked.park?.(path);
      return;
    }
    if (parked !== null && isParked(path)) return parked.unpark?.(path, column);
    if (edit === null) return;
    const value = dropValue(item, column);
    if (value !== undefined) edit(item, "status", value);
  };
  const shared = { compact, now, actions, dragging, onLift: setDragging, canMove: edit !== null };
  const canPark = parked === null ? edit !== null : parked.park !== null;
  // The tall drop place opens a beat after the lift: changing the layout inside `dragstart` can cancel the drag.
  const [dropShown, setDropShown] = useState(false);
  useEffect(() => {
    if (dragging === null || !canPark) {
      setDropShown(false);
      return;
    }
    const timer = setTimeout(() => setDropShown(true), 0);
    return () => clearTimeout(timer);
  }, [dragging, canPark]);
  return (
    <View style={styles.board}>
      {backlog === null ? null : (
        <BacklogBox
          group={backlog}
          open={backlogOpen}
          canMove={canPark}
          dragging={dragging !== null}
          onDrop={(path) => drop(path, backlog.value)}
          onPress={() => setBacklogOpen((open) => !open)}
        />
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.columns} testID="folder-board">
        {backlog === null ? null : backlogOpen ? (
          <Column {...shared} group={backlog} tone="not-started" onDrop={(path) => drop(path, backlog.value)} testID="folder-board-backlog" end={null} />
        ) : dropShown ? (
          <DropPlace group={backlog} onDrop={(path) => drop(path, backlog.value)} />
        ) : null}
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
    </View>
  );
}

/** Backlog, folded: a small box with its count that opens the column, and takes a dropped card to park it. */
function BacklogBox({
  group,
  open,
  canMove,
  dragging,
  onDrop,
  onPress,
}: {
  group: FolderGroup;
  open: boolean;
  canMove: boolean;
  dragging: boolean;
  onDrop: (path: string) => void;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [over, setOver] = useState(false);
  const ref = useColumnDrop({ enabled: canMove, onOver: setOver, onDrop });
  const waiting = canMove && dragging;
  return (
    <View style={styles.boxRow}>
      <Pressable
        ref={ref as never}
        onPress={onPress}
        role="button"
        aria-expanded={open}
        accessibilityLabel={`${group.label}, ${group.items.length}`}
        style={[styles.box, (open || over) && styles.boxOpen, waiting && styles.boxWaiting]}
        testID="folder-board-backlog-box"
      >
        <Text variant="tree" style={{ color: waiting ? colors.accentText : colors.text2 }}>
          {group.label}
        </Text>
        <Text variant="tree" style={styles.count}>
          {String(group.items.length)}
        </Text>
      </Pressable>
    </View>
  );
}

/** While a card is in the air: a tall place at the left of the columns to drop it and park it. */
function DropPlace({ group, onDrop }: { group: FolderGroup; onDrop: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const [over, setOver] = useState(false);
  const ref = useColumnDrop({ enabled: true, onOver: setOver, onDrop });
  return (
    <View
      ref={ref as never}
      style={[styles.dropPlace, over && styles.dropPlaceOver]}
      aria-label={`${group.label}, ${group.items.length}`}
      testID="folder-board-backlog-drop"
    />
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
  /** Drawn at the end of the head: Choose group for a word nobody placed. */
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
    board: { flexGrow: 1, gap: space.x3 },
    columns: { flexGrow: 1, flexDirection: "row", gap: space.x4, paddingBottom: space.x2 },
    boxRow: { flexDirection: "row" },
    box: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 30,
      paddingHorizontal: space.x3,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
    },
    boxOpen: { backgroundColor: colors.surface3 },
    boxWaiting: { borderStyle: "dashed", borderColor: colors.accent },
    // As wide as a column at its narrowest, and as tall as the tallest one beside it.
    dropPlace: { width: BOARD_COLUMN_MIN, minHeight: 240, borderRadius: radii.card, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.accent },
    dropPlaceOver: { backgroundColor: colors.surface3 },
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
