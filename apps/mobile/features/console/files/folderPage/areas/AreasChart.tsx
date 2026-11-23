/**
 * The Chart view of an open area folder: its accountability chart, drawn as
 * boxes instead of rows. The root area is one box on top; its sub-areas sit
 * under it side by side (stacked on a phone), and each sub-area's own
 * sub-areas hang under that as smaller boxes.
 *
 * Every box says who holds the area, how to reach them, how the area is run
 * (its modes, each with what it means on hover), its first metric, and what
 * is missing. The same numbers the List shows, laid out so a person can see
 * the whole structure at once. A box opens its area's own page, and its ⋯
 * button or a right-click opens the seat options. The page keeps the data; this
 * file only draws it, so it takes every lookup and action as a prop.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { baseName } from "../../paths";
import { OwnerFace, type Face } from "../Glyphs";
import { MODE_TIPS, gapOf, type AreaNode, type Seat } from "./seat";

export interface AreasChartProps {
  /** Rooted at the open folder. */
  tree: AreaNode;
  /** Phone layout: columns stack vertically instead of side by side. */
  compact: boolean;
  faceOf: (owner: string | null) => Face;
  /** Display name for an owner word. */
  label: (owner: string) => string;
  /** One-line how-to-reach text; "" when unknown. Shown as a hover title on the owner. */
  reach: (owner: string) => string;
  /** Opens a child area's own page. */
  onOpen: (folder: string) => void;
  /** Seat options: from a right-click, or the ⋯ button (its page coordinates). */
  onMenu: (seat: Seat, at: { x: number; y: number } | null) => void;
  /** Adds a sub-area under the root; the "+ Add area" box is hidden when null. */
  onAdd: ((parent: Seat) => void) | null;
}

/** What every box needs from the page, passed down once rather than per box. */
interface Ctx {
  readonly faceOf: AreasChartProps["faceOf"];
  readonly label: AreasChartProps["label"];
  readonly reach: AreasChartProps["reach"];
  readonly onMenu: AreasChartProps["onMenu"];
}

type Point = { readonly x: number; readonly y: number };

/** Right-click on web, through the native event as `TabStrip` reads it; nothing on a phone. */
function rightClick(open: (at: Point) => void): { readonly onContextMenu?: (event: { preventDefault?: () => void; pageX?: number; pageY?: number }) => void } {
  if (Platform.OS !== "web") return {};
  return {
    onContextMenu: (event) => {
      event.preventDefault?.();
      open({ x: event.pageX ?? 0, y: event.pageY ?? 0 });
    },
  };
}

/** A web hover title; none on a phone, where accessibilityHint carries the same words. */
function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" && text !== "" ? { title: text } : {};
}

export function AreasChart({ tree, compact, faceOf, label, reach, onOpen, onMenu, onAdd }: AreasChartProps) {
  const styles = useThemedStyles(makeStyles);
  const ctx: Ctx = { faceOf, label, reach, onMenu };
  const root = tree.seat;
  return (
    <View style={styles.chart} testID="areas-chart">
      <View style={styles.rootWrap}>
        <SeatBox node={tree} small={false} role="button" onPress={() => onMenu(root, null)} ctx={ctx} />
      </View>
      {tree.areas.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="meta" style={styles.muted}>{`No areas under ${root.name} yet.`}</Text>
          {onAdd === null ? null : <AddBox compact={compact} onPress={() => onAdd(root)} />}
        </View>
      ) : (
        <View style={[styles.row, compact && styles.stack]}>
          {tree.areas.map((child) => (
            <View key={child.seat.folder} style={[styles.column, compact ? styles.columnCompact : styles.columnWide]}>
              <SeatBox node={child} small={false} role="link" onPress={() => onOpen(child.seat.folder)} ctx={ctx} />
              {child.areas.length === 0 ? null : (
                <View style={styles.grand}>
                  {child.areas.map((grand) => (
                    <SeatBox key={grand.seat.folder} node={grand} small role="link" onPress={() => onOpen(grand.seat.folder)} ctx={ctx} />
                  ))}
                </View>
              )}
            </View>
          ))}
          {onAdd === null ? null : <AddBox compact={compact} onPress={() => onAdd(root)} />}
        </View>
      )}
    </View>
  );
}

/** The "+ Add area" ghost box at the end of the children row. */
function AddBox({ compact, onPress }: { compact: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={compact ? styles.columnCompact : styles.columnWide}>
      <Pressable onPress={onPress} role="button" accessibilityLabel="Add area" style={styles.add} testID="area-add">
        <Text variant="meta" style={styles.muted}>
          + Add area
        </Text>
      </Pressable>
    </View>
  );
}

/** One area's box: its seat in words, a press that opens or menus it, and a ⋯ button beside it. */
function SeatBox({
  node,
  small,
  role,
  onPress,
  ctx,
}: {
  node: AreaNode;
  small: boolean;
  role: "link" | "button";
  onPress: () => void;
  ctx: Ctx;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const { seat } = node;
  const gap = gapOf(seat);
  const metric = seat.metrics[0];
  const count = node.files.length;
  const reachText = seat.owner === null ? "" : ctx.reach(seat.owner);
  return (
    <View
      style={[styles.box, hovered && styles.boxHover]}
      testID={`area-box-${seat.folder}`}
      {...rightClick((at) => ctx.onMenu(seat, at))}
    >
      <Pressable
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role={role}
        accessibilityLabel={seat.name}
        style={[styles.body, small && styles.bodySmall]}
      >
        <Text variant="rowTitle" numberOfLines={2} style={styles.name}>
          {seat.name}
        </Text>
        <View style={styles.line} accessibilityHint={reachText === "" ? undefined : reachText} {...hoverTitle(reachText)}>
          <OwnerFace face={ctx.faceOf(seat.owner)} size={20} />
          {seat.owner === null ? (
            <Text variant="tree" style={styles.muted}>
              No owner
            </Text>
          ) : (
            <Text variant="tree" numberOfLines={1} style={styles.ownerName}>
              {ctx.label(seat.owner)}
            </Text>
          )}
        </View>
        {seat.ownerFrom === null ? null : (
          <Text variant="meta" numberOfLines={1} style={styles.muted}>
            {`from ${baseName(seat.ownerFrom)}`}
          </Text>
        )}
        {seat.helper === null ? null : (
          <Text variant="meta" style={styles.muted}>
            + helper
          </Text>
        )}
        {small || seat.modes.length === 0 ? null : (
          <View style={styles.modes}>
            {seat.modes.map((mode, at) => (
              <View key={mode} style={styles.line}>
                {at === 0 ? null : (
                  <Text variant="meta" style={styles.muted}>
                    {" · "}
                  </Text>
                )}
                <Text variant="meta" style={styles.mode} accessibilityHint={MODE_TIPS[mode]} {...hoverTitle(MODE_TIPS[mode])}>
                  {mode}
                </Text>
              </View>
            ))}
          </View>
        )}
        {small || metric === undefined ? null : (
          <Text variant="meta" numberOfLines={1} style={styles.muted}>
            {metric.target === null ? metric.name : `${metric.name} · ${metric.target}`}
          </Text>
        )}
        {gap === null ? null : (
          <Text variant="meta" style={styles.warn}>
            {gap}
          </Text>
        )}
        {count === 0 ? null : (
          <Text variant="meta" style={styles.muted}>
            {count === 1 ? "1 item" : `${count} items`}
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={(event: GestureResponderEvent) => ctx.onMenu(seat, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
        accessibilityLabel={`Options for ${seat.name}`}
        hitSlop={space.x2}
        style={styles.more}
      >
        <Icon name="more" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chart: { width: "100%", gap: space.x4, alignItems: "stretch" },
    rootWrap: { width: "100%", maxWidth: 320, alignSelf: "center" },
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: space.x4 },
    stack: { flexDirection: "column", flexWrap: "nowrap", alignItems: "stretch" },
    column: { gap: space.x3, minWidth: 0 },
    columnWide: { width: 220, maxWidth: "100%", gap: space.x3 },
    columnCompact: { width: "100%", gap: space.x3 },
    grand: { gap: space.x2, marginLeft: space.x4 },
    empty: { gap: space.x3, alignItems: "center" },
    box: {
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      minWidth: 0,
    },
    boxHover: { borderColor: colors.lineStrong },
    body: { padding: space.x3, paddingRight: space.x6 + space.x2, gap: space.x2 },
    bodySmall: { padding: space.x2, paddingRight: space.x6, gap: space.x1 },
    more: { position: "absolute", top: space.x2, right: space.x2, padding: space.x1, borderRadius: radii.sm },
    name: { color: colors.text },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    ownerName: { flexShrink: 1, color: colors.text2 },
    modes: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
    mode: { color: colors.text2 },
    muted: { color: colors.muted },
    warn: { color: colors.warnText },
    add: {
      minHeight: 56,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: space.x3,
      paddingHorizontal: space.x3,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
    },
  });
