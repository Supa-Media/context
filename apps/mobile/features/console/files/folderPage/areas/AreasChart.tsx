/**
 * The Chart view of an open area folder: its accountability chart.
 *
 * On a wide screen it is an org chart, as the owner approved it in the
 * prototype (2026-11-23): the open folder's seat is one box on top (in the
 * Areas folder itself, named for the workspace), a line runs down from it to a
 * bus across one row of columns, one column per area, and each area's own
 * sub-areas stack under its box along a spine. On a phone it is the same tree
 * standing up: the top box, then each area under it on a spine, with an
 * area's sub-areas folded under a "2 sub-areas · Subscriptions, Payroll" foot.
 *
 * A box says, top to bottom: its dot and name, who holds it (and the helper),
 * its first metric, how it is run (each mode with what it means on hover),
 * what is missing, and what else is in the folder by kind. An empty seat is a
 * dashed box with Assign owner. A box opens its area; the top box, its ⋯ and a
 * right-click open the seat options. The page keeps the data; this file only
 * draws it, so it takes every lookup and action as a prop.
 */

import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { OwnerFace, type Face } from "../Glyphs";
import { useRightClick } from "../../rightClick";
import { Polyline, Svg } from "react-native-svg";
import { pressPoint } from "./pressPoint";
import { targetState, type Reading } from "./readings";
import { MODE_TIPS, areaTitle, healthOf, kindCounts, needLook, type AreaNode, type Health, type Seat } from "./seat";

export interface AreasChartProps {
  /** Rooted at the open folder. */
  tree: AreaNode;
  /** The top box's name: the workspace's in the Areas folder, else the area's. */
  rootTitle: string;
  /** Phone layout: the tree stands up instead of spreading across. */
  compact: boolean;
  faceOf: (owner: string | null) => Face;
  /** Display name for an owner word. */
  label: (owner: string) => string;
  /** One-line how-to-reach text; "" when unknown. Shown as a hover title on the owner. */
  reach: (owner: string) => string;
  /** Opens an area's own page. */
  onOpen: (folder: string) => void;
  /** The latest reading of a seat's headline metric, from its `metrics.csv`; undefined when there is none. */
  readingOf: (seat: Seat) => Reading | undefined;
  /** Seat options: from a right-click, the top box, or a ⋯ button (its page coordinates). */
  onMenu: (seat: Seat, at: { x: number; y: number } | null) => void;
  /** Adds a sub-area under a seat; every add button is hidden when null. */
  onAdd: ((parent: Seat) => void) | null;
  /** Opens the seat pop-up on an empty seat; Assign owner is hidden when null. */
  onAssign: ((seat: Seat) => void) | null;
}

type Point = { readonly x: number; readonly y: number };
type Ctx = Pick<AreasChartProps, "faceOf" | "label" | "reach" | "onOpen" | "onMenu" | "onAdd" | "onAssign" | "compact" | "readingOf">;

const pointOf = (event: GestureResponderEvent | undefined): Point | null => (event === undefined ? null : pressPoint(event));

/** A web hover title; none on a phone, where accessibilityHint carries the same words. */
function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" && text !== "" ? { title: text } : {};
}

export function AreasChart(props: AreasChartProps) {
  const { tree, rootTitle, compact } = props;
  const styles = useThemedStyles(makeStyles);
  const ctx: Ctx = props;
  return (
    <View style={styles.chart} testID="areas-chart">
      {compact ? <PhoneTree tree={tree} rootTitle={rootTitle} ctx={ctx} /> : <OrgChart tree={tree} rootTitle={rootTitle} ctx={ctx} />}
    </View>
  );
}

/* ------------------------------ wide: org chart ------------------------------ */

function OrgChart({ tree, rootTitle, ctx }: { tree: AreaNode; rootTitle: string; ctx: Ctx }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const root = tree.seat;
  const columns = tree.areas.length + (ctx.onAdd === null ? 0 : 1);
  return (
    <View style={styles.org}>
      <View style={styles.orgRoot}>
        <SeatBox node={tree} level={0} title={rootTitle} ctx={ctx} />
      </View>
      {tree.areas.length === 0 ? (
        <View style={styles.orgEmpty}>
          <Text variant="meta" style={styles.muted}>
            No sub-areas yet.
          </Text>
          {ctx.onAdd === null ? null : <AddLine label="Add a sub-area" onPress={() => ctx.onAdd?.(root)} />}
        </View>
      ) : (
        <>
          <View style={styles.stem} testID="area-line" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.orgScroll} contentContainerStyle={styles.orgScrollInner}>
            <View style={styles.orgRow}>
              {tree.areas.map((child, at) => (
                <Column key={child.seat.folder} at={at} of={columns}>
                  <SeatBox node={child} level={1} title={areaTitle(child.seat.name)} ctx={ctx} />
                  {child.areas.length === 0 ? null : (
                    <View style={styles.orgSub}>
                      <View style={styles.orgSpine} testID="area-line" />
                      {child.areas.map((grand) => (
                        <View key={grand.seat.folder}>
                          <View style={styles.orgElbow} />
                          <SeatBox node={grand} level={2} title={areaTitle(grand.seat.name)} ctx={ctx} />
                        </View>
                      ))}
                    </View>
                  )}
                </Column>
              ))}
              {ctx.onAdd === null ? null : (
                <Column at={columns - 1} of={columns}>
                  <Pressable onPress={() => ctx.onAdd?.(root)} role="button" accessibilityLabel="Add area" style={styles.ghost} testID="area-add">
                    <Icon name="plus" size={14} color={colors.muted} />
                    <Text variant="meta" style={styles.muted}>
                      Add area
                    </Text>
                  </Pressable>
                </Column>
              )}
            </View>
          </ScrollView>
        </>
      )}
    </View>
  );
}

/** One column under the bus: its stretch of the bus and its drop to the box. */
function Column({ at, of, children }: { at: number; of: number; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const first = at === 0;
  const last = at === of - 1;
  return (
    <View style={styles.column}>
      {of > 1 ? <View style={[styles.bus, first && styles.busFirst, last && styles.busLast]} testID="area-line" /> : null}
      <View style={styles.drop} />
      {children}
    </View>
  );
}

/* ------------------------------ phone: standing tree ------------------------------ */

function PhoneTree({ tree, rootTitle, ctx }: { tree: AreaNode; rootTitle: string; ctx: Ctx }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (folder: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const branch = (node: AreaNode, level: number, title: string): React.ReactNode => {
    const shown = level === 0 || open.has(node.seat.folder);
    return (
      <View key={node.seat.folder}>
        {level === 0 ? null : <View style={styles.elbow} />}
        <SeatBox
          node={node}
          level={level}
          title={title}
          ctx={ctx}
          fold={level > 0 && node.areas.length > 0 ? { open: open.has(node.seat.folder), toggle: () => toggle(node.seat.folder) } : undefined}
        />
        {shown && node.areas.length > 0 ? (
          <View style={[styles.kids, level > 0 && styles.kidsDeep]}>
            <View style={styles.spine} testID="area-line" />
            {node.areas.map((child) => branch(child, level + 1, areaTitle(child.seat.name)))}
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <View>
      {branch(tree, 0, rootTitle)}
      {tree.areas.length === 0 && ctx.onAdd !== null ? <AddLine label="Add a sub-area" onPress={() => ctx.onAdd?.(tree.seat)} /> : null}
      {tree.areas.length > 0 && ctx.onAdd !== null ? (
        <Pressable onPress={() => ctx.onAdd?.(tree.seat)} role="button" accessibilityLabel="Add area" style={[styles.ghost, styles.ghostPhone]} testID="area-add">
          <Icon name="plus" size={14} color={colors.muted} />
          <Text variant="meta" style={styles.muted}>
            Add area
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ------------------------------ one box ------------------------------ */

function HealthDot({ health, size = 7 }: { health: Health; size?: number }) {
  const colors = useColors();
  const ring = health === "ring";
  return (
    <View
      aria-hidden
      testID={`area-dot-${health}`}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: ring ? "transparent" : health === "warn" ? colors.warn : colors.muted,
        borderWidth: ring ? 1 : 0,
        borderStyle: "dashed",
        borderColor: colors.lineStrong,
      }}
    />
  );
}

function SeatBox({
  node,
  level,
  title,
  ctx,
  fold,
}: {
  node: AreaNode;
  level: 0 | 1 | 2 | number;
  title: string;
  ctx: Ctx;
  fold?: { open: boolean; toggle: () => void };
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const { seat } = node;
  const top = level === 0;
  const empty = seat.owner === null;
  const metric = seat.metrics[0];
  const reading = metric === undefined ? undefined : ctx.readingOf(seat);
  const state = metric === undefined ? "unknown" : targetState(reading, metric.target);
  const files = top ? "" : kindCounts(node.files);
  const ownerText = empty ? "No owner" : `${ctx.label(seat.owner as string)}${seat.helper === null ? "" : ` + ${seat.helper}`}`;
  const reachText = empty ? "" : ctx.reach(seat.owner as string);
  const look = top ? needLook(node) : 0;
  const open = (event?: GestureResponderEvent) => (top ? ctx.onMenu(seat, pointOf(event)) : ctx.onOpen(seat.folder));
  const menuClick = useRightClick((at) => {
    ctx.onMenu(seat, at);
    return true;
  });
  return (
    <View
      style={[styles.box, ctx.compact && styles.boxPhone, top && styles.boxRoot, empty && !top && styles.boxEmpty, hovered && styles.boxHover]}
      testID={`area-box-${seat.folder}`}
      ref={menuClick.ref as never}
    >
      <Pressable
        onPress={open}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role={top ? "button" : "link"}
        accessibilityLabel={title}
        style={[styles.body, ctx.compact && styles.bodyPhone]}
      >
        <View style={styles.titleRow}>
          <HealthDot health={healthOf(seat, state === "missed")} />
          <Text variant="rowTitle" numberOfLines={1} style={[styles.name, top && styles.rootName]}>
            {title}
          </Text>
        </View>
        <View style={styles.line} accessibilityHint={reachText === "" ? undefined : reachText} {...hoverTitle(reachText)}>
          <OwnerFace face={ctx.faceOf(seat.owner)} size={ctx.compact ? 24 : 20} />
          <Text variant="tree" numberOfLines={1} style={[styles.owner, empty && styles.muted]}>
            {ownerText}
          </Text>
        </View>
        {top ? (
          node.areas.length === 0 ? null : (
            <Text variant="meta" style={styles.muted}>
              {`${node.areas.length} ${node.areas.length === 1 ? "area" : "areas"}`}
              {look === 0 ? null : (
                <Text variant="meta" style={styles.warn}>
                  {` · ${look} need${look === 1 ? "s" : ""} a look`}
                </Text>
              )}
            </Text>
          )
        ) : metric !== undefined ? (
          <View testID="area-metric">
            <View style={styles.metric}>
              <Text variant="meta" numberOfLines={1} style={[styles.muted, styles.metricName]}>
                {metric.name}
              </Text>
              <Text
                variant="rowTitle"
                style={[styles.metricValue, state === "met" && { color: colors.ok }, state === "missed" && { color: colors.warn }]}
                testID="area-metric-value"
                {...hoverTitle(reading?.date ?? "")}
              >
                {reading?.value ?? "—"}
              </Text>
            </View>
            <Text variant="meta" numberOfLines={1} style={styles.muted} testID="area-metric-target">
              {metric.target === null ? "No target yet" : `Target ${metric.target}${state === "met" ? " · on target" : state === "missed" ? " · off target" : ""}`}
            </Text>
            {reading !== undefined && reading.series.length > 1 ? <Spark series={reading.series} /> : null}
          </View>
        ) : empty ? null : (
          <Text variant="meta" style={styles.muted}>
            No metric yet
          </Text>
        )}
        {top || seat.modes.length === 0 ? null : (
          <View style={styles.modes}>
            {seat.modes.map((mode, at) => (
              <Text key={mode} variant="meta" style={styles.muted}>
                {at === 0 ? "" : " · "}
                <Text variant="meta" style={styles.mode} accessibilityHint={MODE_TIPS[mode]} {...hoverTitle(MODE_TIPS[mode])}>
                  {mode}
                </Text>
              </Text>
            ))}
          </View>
        )}
        {files === "" ? null : (
          <Text variant="treeMeta" style={styles.muted} testID="area-files">
            {files}
          </Text>
        )}
        {empty && !top && ctx.onAssign !== null ? (
          <Pressable onPress={() => ctx.onAssign?.(seat)} role="button" style={styles.assign} testID={`area-assign-${seat.folder}`}>
            <Text variant="tree" style={styles.assignText}>
              Assign owner
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
      {fold === undefined ? null : (
        <Pressable onPress={fold.toggle} role="button" aria-expanded={fold.open} style={styles.foot} testID={`area-fold-${seat.folder}`}>
          <Text variant="treeMeta" numberOfLines={1} style={[styles.muted, styles.footText]}>
            {fold.open ? "Hide sub-areas" : `${node.areas.length} sub-area${node.areas.length === 1 ? "" : "s"} · ${node.areas.map((a) => areaTitle(a.seat.name)).join(", ")}`}
          </Text>
          <Icon name={fold.open ? "chevronUp" : "chevronDown"} size={12} color={colors.muted} />
        </Pressable>
      )}
      <Pressable
        onPress={(event: GestureResponderEvent) => ctx.onMenu(seat, pointOf(event))}
        onHoverIn={() => setHovered(true)}
        accessibilityLabel={`Options for ${seat.name}`}
        hitSlop={space.x2}
        style={[styles.more, hovered || ctx.compact ? styles.shown : styles.faint]}
      >
        <Icon name="more" size={16} color={colors.muted} />
      </Pressable>
      {top || ctx.onAdd === null || ctx.compact ? null : (
        <Pressable
          onPress={() => ctx.onAdd?.(seat)}
          onHoverIn={() => setHovered(true)}
          accessibilityLabel={`Add a sub-area under ${title}`}
          hitSlop={space.x1}
          style={[styles.addSub, hovered ? styles.shown : styles.hidden]}
          testID={`area-add-sub-${seat.folder}`}
        >
          <Icon name="plus" size={12} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}

function AddLine({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable onPress={onPress} role="button" style={styles.addLine} testID="area-add">
      <Icon name="plus" size={12} color={colors.accentText} />
      <Text variant="tree" style={{ color: colors.accentText }}>
        {label}
      </Text>
    </Pressable>
  );
}

const LINE = 1;
const DROP = 20;
const COLUMN_GAP = 12;

/** `.spark`: the readings, oldest first, as one line across the box. */
function Spark({ series }: { series: readonly number[] }) {
  const colors = useColors();
  const W = 120;
  const H = 22;
  const low = Math.min(...series);
  const span = Math.max(...series) - low || 1;
  const points = series.map((n, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - 2 - ((n - low) / span) * (H - 4)).toFixed(1)}`).join(" ");
  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" testID="area-spark" aria-hidden>
      <Polyline points={points} fill="none" stroke={colors.chromeMuted} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chart: { width: "100%" },
    muted: { color: colors.muted },
    warn: { color: colors.warnText },

    org: { alignItems: "center", width: "100%" },
    orgRoot: { width: "100%", maxWidth: 300 },
    orgEmpty: { alignItems: "center", gap: space.x2, paddingTop: space.x4 },
    stem: { width: LINE, height: DROP, backgroundColor: colors.lineStrong },
    orgScroll: { width: "100%" },
    orgScrollInner: { flexGrow: 1, justifyContent: "center" },
    orgRow: { flexDirection: "row", alignItems: "flex-start", gap: COLUMN_GAP, flexGrow: 1 },
    column: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 124, maxWidth: 220, paddingTop: DROP, position: "relative" },
    bus: { position: "absolute", top: 0, left: -COLUMN_GAP / 2, right: -COLUMN_GAP / 2, height: LINE, backgroundColor: colors.lineStrong },
    busFirst: { left: "50%" },
    busLast: { right: "50%" },
    drop: { position: "absolute", top: 0, left: "50%", width: LINE, height: DROP, backgroundColor: colors.lineStrong },
    orgSub: { position: "relative", marginLeft: 14, paddingTop: space.x2, gap: space.x2 },
    orgSpine: { position: "absolute", left: -8, top: 0, bottom: 22, width: LINE, backgroundColor: colors.lineStrong },
    orgElbow: { position: "absolute", left: -8, top: 22, width: 8, height: LINE, backgroundColor: colors.lineStrong },

    kids: { position: "relative", paddingLeft: 20, marginTop: 16, gap: space.x2 },
    kidsDeep: { marginTop: space.x2 },
    spine: { position: "absolute", left: 10, top: -16, bottom: 28, width: LINE, backgroundColor: colors.lineStrong },
    elbow: { position: "absolute", left: -10, top: 28, width: 10, height: LINE, backgroundColor: colors.lineStrong },

    box: {
      position: "relative",
      backgroundColor: colors.cardSurface,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      minWidth: 0,
    },
    boxPhone: { borderRadius: 18 },
    boxRoot: { backgroundColor: colors.rootSurface, borderColor: "transparent" },
    // `.t-rootname`: 16 on 24, 600, -0.32.
    rootName: { fontSize: pointerType.body, lineHeight: 24, letterSpacing: -0.32 },
    boxEmpty: { backgroundColor: "transparent", borderStyle: "dashed", borderColor: colors.lineStrong },
    boxHover: { borderColor: colors.lineStrong },
    body: { padding: 12, paddingRight: 34, gap: 6 },
    bodyPhone: { padding: 16, paddingRight: 40, gap: 10 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    name: { color: colors.text, flexShrink: 1 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    owner: { flexShrink: 1, color: colors.text2 },
    metric: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 6, minWidth: 0, flexWrap: "wrap" },
    metricName: { flexShrink: 1 },
    metricValue: { color: colors.text, fontVariant: ["tabular-nums"] },
    modes: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
    mode: {
      color: colors.text2,
      textDecorationLine: "underline",
      textDecorationStyle: "dotted",
      textDecorationColor: colors.lineStrong,
    },
    assign: {
      alignSelf: "flex-start",
      marginTop: 2,
      paddingVertical: 5,
      paddingHorizontal: 12,
      borderRadius: radii.sm,
      backgroundColor: colors.chipFill,
    },
    assignText: { color: colors.text, fontWeight: "600" },
    foot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    footText: { flexShrink: 1 },
    more: { position: "absolute", top: 8, right: 8, padding: 3, borderRadius: radii.sm },
    addSub: { position: "absolute", bottom: 8, right: 8, padding: 4, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    shown: { opacity: 1 },
    faint: { opacity: 0.45 },
    hidden: { opacity: 0 },
    ghost: {
      minHeight: 72,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      borderRadius: 10,
    },
    ghostPhone: { marginTop: space.x3, minHeight: 56, borderRadius: 18 },
    addLine: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  });
