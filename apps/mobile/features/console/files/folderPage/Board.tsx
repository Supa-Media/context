/**
 * The Board view of a folder page: one column per status, cards in them
 * (spec A2). The same groups the List view draws, laid out sideways, with a
 * column for every status the menu offers even while nothing is in it, and
 * "No status" last (`boardGroups` in `model.ts`).
 *
 * A card is `chipFill` on a `line` hairline, not `surface2` — in the dark
 * palette `surface2` is the page, and the card would vanish. Moving a card
 * is its status value, two ways that land in the same `choose`: drag it to
 * another column with a pointer (`boardDrag.web.ts`; dropping on "No status"
 * clears it), or press the status on the card and pick — the only way on a
 * phone or from a keyboard, so it is always drawn, never hidden until hover.
 * Either way the card moves at once and comes back, with the reason, if the
 * write is refused. The columns scroll sideways when they outgrow the page,
 * on a phone as on a desktop, and a long column scrolls with the page.
 */

import { StyleSheet, ScrollView, Pressable, View, type ViewStyle } from "react-native";
import { useState, type ReactNode } from "react";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { shortWhen } from "../listBlock/words";
import { dropValue, NEW_FRONT_NOTE, type FolderGroup, type FolderItem } from "./model";
import { PropertyValue } from "./PropertyValue";
import { useCardDrag, useColumnDrop } from "./boardDrag";
import { textOf, type ItemActions } from "./items";

/** A column's width at rest; columns narrow to `BOARD_COLUMN_MIN` before the board scrolls. */
export const BOARD_COLUMN = 240;
const BOARD_COLUMN_MIN = 200;

export function FolderBoard({
  groups,
  compact,
  now,
  actions,
}: {
  groups: readonly FolderGroup[];
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [dragging, setDragging] = useState<string | null>(null);
  const edit = actions.onChoose;
  const drop = (path: string, column: string) => {
    setDragging(null);
    const item = groups.flatMap((group) => group.items).find((each) => each.path === path);
    if (item === undefined || edit === null) return;
    const value = dropValue(item, column);
    if (value !== undefined) edit(item, "status", value);
  };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.columns} testID="folder-board">
      {groups.map((group) => (
        <Column
          key={group.value.toLowerCase()}
          group={group}
          compact={compact}
          canMove={edit !== null}
          dragging={dragging}
          onDrop={(path) => drop(path, group.value)}
        >
          {group.items.map((item) => (
            <Card
              key={item.path}
              item={item}
              now={now}
              actions={actions}
              compact={compact}
              lifted={dragging === item.path}
              onLift={(lifted) => setDragging(lifted ? item.path : null)}
            />
          ))}
        </Column>
      ))}
    </ScrollView>
  );
}

function Column({
  group,
  compact,
  canMove,
  dragging,
  onDrop,
  children,
}: {
  group: FolderGroup;
  compact: boolean;
  canMove: boolean;
  dragging: string | null;
  onDrop: (path: string) => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const [over, setOver] = useState(false);
  const ref = useColumnDrop({ enabled: canMove, onOver: setOver, onDrop });
  const empty = group.items.length === 0;
  return (
    <View
      ref={ref as never}
      style={[styles.column, compact && styles.columnTouch]}
      testID="folder-board-column"
      aria-label={`${group.label}, ${group.items.length}`}
    >
      <View style={styles.head}>
        <Text variant="rowTitle">{group.label}</Text>
        <Text variant="tree" style={styles.count}>
          {String(group.items.length)}
        </Text>
      </View>
      <View style={[styles.cards, over && styles.cardsOver, dragging !== null && empty && styles.cardsWaiting]}>
        {children}
        {empty ? (
          <Text variant="meta" style={styles.empty} testID="folder-board-empty">
            {canMove && dragging !== null ? "Drop here" : "Nothing here"}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Card({
  item,
  now,
  actions,
  compact,
  lifted,
  onLift,
}: {
  item: FolderItem;
  now: number;
  actions: ItemActions;
  compact: boolean;
  lifted: boolean;
  onLift: (lifted: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const owner = textOf(item.properties, "owner");
  const meta = [owner === "" ? null : owner, item.updatedAt === null ? null : shortWhen(item.updatedAt, now)].filter(Boolean).join(" · ");
  const edit = actions.onChoose;
  const ref = useCardDrag({ path: item.path, enabled: edit !== null, onStart: () => onLift(true), onEnd: () => onLift(false) });
  return (
    <View ref={ref as never} style={lifted && styles.lifted} testID="folder-card-drag">
      <Pressable
        onPress={() => actions.onOpen(item)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
        style={[styles.card, hovered && styles.cardHover, edit !== null && !compact && styles.grab]}
        testID="folder-card"
      >
        <Text variant="body" numberOfLines={2} style={styles.name}>
          {item.label}
        </Text>
        <View style={styles.foot}>
          <Text variant="meta" numberOfLines={1} style={styles.meta}>
            {item.progress === null ? meta : [meta, `${item.progress.done}/${item.progress.total}`].filter(Boolean).join(" · ")}
          </Text>
          {edit === null ? null : (
            <PropertyValue
              property="status"
              value={item.status}
              choices={actions.choices("status")}
              savesTo={item.creates ? NEW_FRONT_NOTE : null}
              onChoose={(value) => edit(item, "status", value)}
              variant="meta"
              style={styles.status}
              testID="folder-card-status"
            />
          )}
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    columns: { flexGrow: 1, gap: space.x4, paddingBottom: space.x2 },
    column: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: BOARD_COLUMN_MIN, maxWidth: BOARD_COLUMN + 40 },
    columnTouch: { flexGrow: 0, flexBasis: "auto", width: 264, minWidth: 264, maxWidth: 264 },
    head: { flexDirection: "row", alignItems: "baseline", gap: space.x2, height: 32, paddingTop: space.x2 },
    count: { color: colors.chromeMuted },
    // A column is a drop target down its whole height, not only where its cards end.
    cards: { gap: space.x2, marginTop: space.x1, minHeight: 64, padding: 2, borderRadius: radii.card, borderWidth: 1, borderColor: "transparent" },
    cardsOver: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },
    cardsWaiting: { borderColor: colors.line, borderStyle: "dashed" },
    empty: { color: colors.chromeMuted, paddingVertical: space.x3, textAlign: "center" },
    card: {
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      padding: space.x3,
      gap: space.x1,
    },
    cardHover: { borderColor: colors.lineStrong },
    // Web only, and not in `ViewStyle`s cursor names: asserted through, as `AppFrame` does for its resize cursor.
    grab: { cursor: "grab" as unknown as ViewStyle["cursor"] },
    lifted: { opacity: 0.4 },
    name: { color: colors.text },
    foot: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    meta: { flexGrow: 1, flexShrink: 1, color: colors.muted },
    status: { color: colors.muted },
  });
