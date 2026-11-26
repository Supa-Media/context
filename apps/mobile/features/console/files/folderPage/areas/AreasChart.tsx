/**
 * The Chart view of an open area folder: its accountability chart, as the
 * owner approved it on 2026-11-24 (the Areas redesign board, "Chart view, one
 * metric with trend").
 *
 * On a wide screen it is an org chart: the open folder's seat is one box on
 * top (in the Areas folder itself, named for the workspace), a line runs down
 * from it to a bus across one row of columns, one column per area, and each
 * area's own sub-areas stack under its box along a spine, as compact boxes.
 * On a phone it is the same tree standing up: the top box, then each area
 * under it on a spine, with an area's sub-areas folded under a
 * "2 sub-areas · Subscriptions, Payroll" foot.
 *
 * Trimmed for people who do not live in the numbers (the owner, 2026-11-26,
 * the simplified Areas page): an area's box says its owner's face and name,
 * who holds it, and its one metric (its name, the value with the goal in
 * words, and one verdict from `verdict.ts` in words and a mark). Its
 * sub-areas are folded on every screen under an "6 inside · 1 needs a look"
 * line; open, each is a compact box with its name and value. The trend, how
 * the area is run, its projects and its notes are in the side panel. An empty seat is a dashed box
 * with Assign owner. A box opens its area; the top box, a ⋯ and a right-click
 * open the seat options. The page keeps the data; this file only draws it,
 * so it takes every lookup and action as a prop.
 */

import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { areasType, pointerType } from "../../../../design/tokens";
import { OwnerFace, type Face } from "../Glyphs";
import { useRightClick } from "../../rightClick";
import { pressPoint } from "./pressPoint";
import type { Reading } from "./readings";
import { headlineOf, type Headline } from "./headline";
import { VerdictMark } from "./AreaMetricCell";
import { areaTitle, needLook, type AreaNode, type Seat } from "./seat";
import type { AreaProjects } from "./areaProjects";
import { useFolds, type FoldHome } from "./foldMemory";

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
  /** An area box pressed: the side panel on a desktop (a second press opens it), else its page. Defaults to `onOpen`. */
  onArea?: (folder: string) => void;
  /** The latest reading of a seat's headline metric, from its `metrics.csv`; undefined when there is none. */
  readingOf: (seat: Seat) => Reading | undefined;
  /** Seat options: from a right-click, the top box, or a ⋯ button (its page coordinates). */
  onMenu: (seat: Seat, at: { x: number; y: number } | null) => void;
  /** Adds a sub-area under a seat; every add button is hidden when null. */
  onAdd: ((parent: Seat) => void) | null;
  /** Opens the seat pop-up on an empty seat; Assign owner is hidden when null. */
  onAssign: ((seat: Seat) => void) | null;
  /** The projects that serve an area or its sub-areas; absent where the Projects folder is not read. */
  projectsOf?: (folder: string) => AreasProjectsCount;
  /** Where the folds are kept for this viewer (`foldMemory.ts`); absent, they last while the page is open. */
  remember?: FoldHome;
}

type AreasProjectsCount = Pick<AreaProjects, "inProgress">;

type Point = { readonly x: number; readonly y: number };
type Ctx = Pick<AreasChartProps, "faceOf" | "label" | "reach" | "onOpen" | "onMenu" | "onAdd" | "onAssign" | "compact" | "readingOf" | "projectsOf"> & {
  readonly onArea: (folder: string) => void;
  /** Whether an area's sub-areas are showing under it. */
  readonly isOpen: (folder: string) => boolean;
  readonly toggle: (folder: string) => void;
};

const pointOf = (event: GestureResponderEvent | undefined): Point | null => (event === undefined ? null : pressPoint(event));

/** A web hover title; none on a phone, where accessibilityHint carries the same words. */
function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" && text !== "" ? { title: text } : {};
}

const LINE = 1;
/** The stem under the top box, and each column's drop from the bus. */
const DROP = 24;
const COLUMN = 232;
const COLUMN_GAP = 20;
/** A sub-area's box sits this far in from its area's, its spine 8 left of it, under the area's face. */
const SUB_INSET = 28;
const SUB_GAP = 8;
/** Where a compact box's elbow meets it: the middle of its name line. */
const SUB_ELBOW = 17;

export function AreasChart(props: AreasChartProps) {
  const { tree, rootTitle, compact } = props;
  const styles = useThemedStyles(makeStyles);
  // Every area's sub-areas start folded, on a wide screen as on a phone (the owner, 2026-11-26),
  // and what a viewer unfolds is kept for them (the owner, 2026-11-26).
  const [open, toggle] = useFolds(props.remember === undefined ? undefined : { ...props.remember, view: "chart" });
  const ctx: Ctx = { ...props, onArea: props.onArea ?? props.onOpen, isOpen: (folder) => open.has(folder), toggle };
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
        <RootBox node={tree} title={rootTitle} ctx={ctx} />
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
                  <AreaBox node={child} level={1} ctx={ctx} fold={child.areas.length > 0 ? { open: ctx.isOpen(child.seat.folder), toggle: () => ctx.toggle(child.seat.folder) } : undefined} />
                  {(ctx.isOpen(child.seat.folder) ? child.areas : []).map((grand, index) => (
                    <View key={grand.seat.folder} style={styles.sub}>
                      <View style={[styles.subSpine, index === child.areas.length - 1 ? styles.subSpineLast : styles.subSpineOn]} testID="area-line" />
                      <View style={styles.subElbow} />
                      <SubBox node={grand} ctx={ctx} />
                    </View>
                  ))}
                </Column>
              ))}
              {ctx.onAdd === null ? null : (
                <Column at={columns - 1} of={columns}>
                  <Pressable onPress={() => ctx.onAdd?.(root)} role="button" accessibilityLabel="Add area" style={styles.ghost} testID="area-add">
                    <Svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
                      <Path d="M6 1.5v9M1.5 6h9" stroke={colors.muted} strokeWidth={1.5} strokeLinecap="round" />
                    </Svg>
                    <Text variant="tree" style={styles.ghostText}>
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
  // Each branch draws its own piece of the spine, so the line stops at the last branch's elbow however tall that box is.
  const branch = (node: AreaNode, level: number, at: number, of: number): React.ReactNode => {
    const shown = ctx.isOpen(node.seat.folder);
    const lift = at === 0 ? (level === 1 ? 16 : 8) : 8;
    return (
      <View key={node.seat.folder}>
        <View style={[styles.spine, { top: -lift }, at === of - 1 ? { height: lift + 29 } : styles.spineOn]} testID="area-line" />
        <View style={styles.elbow} />
        <AreaBox
          node={node}
          level={level}
          ctx={ctx}
          fold={node.areas.length > 0 ? { open: shown, toggle: () => ctx.toggle(node.seat.folder) } : undefined}
        />
        {shown && node.areas.length > 0 ? (
          <View style={[styles.kids, styles.kidsDeep]}>
            {node.areas.map((child, at) => branch(child, level + 1, at, node.areas.length))}
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <View>
      <RootBox node={tree} title={rootTitle} ctx={ctx} />
      {tree.areas.length > 0 ? (
        <View style={styles.kids}>
          {tree.areas.map((child, at) => branch(child, 1, at, tree.areas.length))}
        </View>
      ) : null}
      {tree.areas.length === 0 && ctx.onAdd !== null ? <AddLine label="Add a sub-area" onPress={() => ctx.onAdd?.(tree.seat)} /> : null}
      {tree.areas.length > 0 && ctx.onAdd !== null ? (
        <Pressable onPress={() => ctx.onAdd?.(tree.seat)} role="button" accessibilityLabel="Add area" style={[styles.ghost, styles.ghostPhone]} testID="area-add">
          <Svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
            <Path d="M6 1.5v9M1.5 6h9" stroke={colors.muted} strokeWidth={1.5} strokeLinecap="round" />
          </Svg>
          <Text variant="tree" style={styles.ghostText}>
            Add area
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ------------------------------ the boxes ------------------------------ */

/** The ⋯ in a box's corner: faint until the box is hovered, always shown on a phone. */
function More({ seat, ctx, shown, onHover, style }: { seat: Seat; ctx: Ctx; shown: boolean; onHover: () => void; style: object }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={(event: GestureResponderEvent) => ctx.onMenu(seat, pointOf(event))}
      onHoverIn={onHover}
      accessibilityLabel={`Options for ${seat.name}`}
      hitSlop={8}
      style={[style, { opacity: shown || ctx.compact ? 1 : 0.45 }]}
    >
      <Icon name="more" size={14} color={colors.muted} />
    </Pressable>
  );
}

function ownerLine(seat: Seat, ctx: Ctx): string {
  if (seat.owner === null) return "No owner";
  return `${ctx.label(seat.owner)}${seat.delegate === null ? "" : ` + ${seat.delegate}`}`;
}

/** The open folder's box: its name, who holds it, and how many of its areas need a look. Pressing it opens the seat options. */
function RootBox({ node, title, ctx }: { node: AreaNode; title: string; ctx: Ctx }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { seat } = node;
  const look = needLook(node, (child) => headlineOf(child, ctx.readingOf(child))?.verdict?.good === false);
  const headline = headlineOf(seat, ctx.readingOf(seat));
  const reachText = seat.owner === null ? "" : ctx.reach(seat.owner);
  const menuClick = useRightClick((at) => {
    ctx.onMenu(seat, at);
    return true;
  });
  return (
    <View ref={menuClick.ref as never}>
      <Pressable
        onPress={(event: GestureResponderEvent) => ctx.onMenu(seat, pointOf(event))}
        role="button"
        accessibilityLabel={title}
        style={[styles.rootBox, ctx.compact && styles.rootBoxPhone]}
        testID={`area-box-${seat.folder}`}
      >
        <View style={styles.rootTop}>
          <Text variant="rowTitle" numberOfLines={1} style={styles.rootName}>
            {title}
          </Text>
          <Icon name="more" size={14} color={colors.muted} />
        </View>
        <View style={styles.ownerRow} accessibilityHint={reachText === "" ? undefined : reachText} {...hoverTitle(reachText)}>
          <OwnerFace face={ctx.faceOf(seat.owner)} size={16} />
          <Text variant="tree" numberOfLines={1} style={styles.rootOwner}>
            {ownerLine(seat, ctx)}
          </Text>
        </View>
        {headline === null || headline.value === null ? null : <BoxMetric headline={headline} />}
        {node.areas.length === 0 ? null : (
          <Text variant="treeMeta" style={styles.small}>
            {`${node.areas.length} ${node.areas.length === 1 ? "area" : "areas"}`}
            {look === 0 ? null : <Text variant="treeMeta" style={styles.look}>{` · ${look} need${look === 1 ? "s" : ""} a look`}</Text>}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

function valueInk(colors: Colors, headline: Headline): string {
  if (headline.status === "hidden" || headline.status === "loading") return colors.muted;
  return headline.state === "met" ? colors.okText : headline.state === "missed" ? colors.warnText : colors.text;
}

/** "6 inside · 1 needs a look": how many areas are folded under a box and how many of them need a look. */
export function insideWords(count: number, look: number): string {
  return `${count} inside${look === 0 ? "" : ` · ${look} need${look === 1 ? "s" : ""} a look`}`;
}

/** An area's box: name and holder, its metric, and a foot. Unowned, a dashed box offering Assign owner. */
function AreaBox({ node, level, ctx, fold }: { node: AreaNode; level: number; ctx: Ctx; fold?: { open: boolean; toggle: () => void } }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const { seat } = node;
  const title = areaTitle(seat.name);
  const headline = headlineOf(seat, ctx.readingOf(seat));
  const look = needLook(node, (child) => headlineOf(child, ctx.readingOf(child))?.verdict?.good === false);
  const reachText = seat.owner === null ? "" : ctx.reach(seat.owner);
  const menuClick = useRightClick((at) => {
    ctx.onMenu(seat, at);
    return true;
  });
  if (seat.owner === null) return <EmptyBox seat={seat} ctx={ctx} big />;
  return (
    <View style={[styles.box, ctx.compact && styles.boxPhone, hovered && styles.boxHover]} testID={`area-box-${seat.folder}`} ref={menuClick.ref as never}>
      <Pressable
        onPress={() => ctx.onArea(seat.folder)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        accessibilityLabel={title}
        style={[styles.body, ctx.compact && styles.bodyPhone]}
        {...{ dataSet: { level: String(level) } }}
      >
        <View style={styles.nameBlock}>
          <View style={styles.nameRow} accessibilityHint={reachText === "" ? undefined : reachText} {...hoverTitle(reachText)}>
            <OwnerFace face={ctx.faceOf(seat.owner)} size={16} />
            <Text variant="rowTitle" numberOfLines={1} style={styles.name}>
              {title}
            </Text>
          </View>
          <Text variant="treeMeta" numberOfLines={1} style={styles.ownerText}>
            {ownerLine(seat, ctx)}
          </Text>
        </View>
        {headline === null ? (
          <Text variant="treeMeta" style={styles.small}>
            No metric yet
          </Text>
        ) : (
          <BoxMetric headline={headline} />
        )}
      </Pressable>
      {fold === undefined ? null : (
        <Pressable onPress={fold.toggle} role="button" aria-expanded={fold.open} accessibilityLabel={`${fold.open ? "Hide" : "Show"} the areas in ${title}`} style={styles.fold} testID={`area-fold-${seat.folder}`}>
          <Text variant="treeMeta" numberOfLines={1} style={[styles.small, styles.foldText]}>
            {insideWords(node.areas.length, 0)}
            {look === 0 ? null : <Text variant="treeMeta" style={styles.look}>{` · ${look} need${look === 1 ? "s" : ""} a look`}</Text>}
          </Text>
          <Icon name={fold.open ? "chevronUp" : "chevronDown"} size={12} color={colors.muted} />
        </Pressable>
      )}
      <More seat={seat} ctx={ctx} shown={hovered} onHover={() => setHovered(true)} style={styles.more} />
      {ctx.onAdd === null || ctx.compact ? null : (
        <Pressable
          onPress={() => ctx.onAdd?.(seat)}
          onHoverIn={() => setHovered(true)}
          accessibilityLabel={`Add a sub-area under ${title}`}
          hitSlop={4}
          style={[styles.addSub, { opacity: hovered ? 1 : 0 }]}
          testID={`area-add-sub-${seat.folder}`}
        >
          <Icon name="plus" size={12} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}

/** An area box's metric: its name, the value with the goal in words, then the verdict in words and a mark. */
function BoxMetric({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.boxMetric} testID="area-metric" {...hoverTitle(headline.date)}>
      <Text variant="treeMeta" style={styles.small} numberOfLines={2}>
        {headline.label}
      </Text>
      {headline.value === null ? (
        <Text variant="tree" style={styles.noReadings} testID="area-metric-value">
          {headline.goal === "" ? "No readings yet" : `No readings yet · ${headline.goal}`}
        </Text>
      ) : (
        <>
          <View style={styles.valueLine}>
            <Text variant="tree" style={[styles.bigValue, { color: valueInk(colors, headline) }]} numberOfLines={1} testID="area-metric-value">
              {headline.value}
            </Text>
            <Text variant="treeMeta" style={styles.target} numberOfLines={1} testID="area-metric-target">
              {headline.goal}
            </Text>
          </View>
          {headline.verdict === null ? null : <VerdictMark verdict={headline.verdict} />}
        </>
      )}
    </View>
  );
}

/** A sub-area's compact box: face and name, then the metric's one line. */
function SubBox({ node, ctx }: { node: AreaNode; ctx: Ctx }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const { seat } = node;
  const title = areaTitle(seat.name);
  const headline = headlineOf(seat, ctx.readingOf(seat));
  const reachText = seat.owner === null ? "" : `${ctx.label(seat.owner)}${ctx.reach(seat.owner) === "" ? "" : ` · ${ctx.reach(seat.owner)}`}`;
  const menuClick = useRightClick((at) => {
    ctx.onMenu(seat, at);
    return true;
  });
  if (seat.owner === null) return <EmptyBox seat={seat} ctx={ctx} />;
  return (
    <View style={[styles.box, hovered && styles.boxHover]} testID={`area-box-${seat.folder}`} ref={menuClick.ref as never}>
      <Pressable
        onPress={() => ctx.onArea(seat.folder)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        accessibilityLabel={title}
        style={styles.subBody}
        {...{ dataSet: { level: "2" } }}
      >
        <View style={[styles.nameRow, styles.subNameRow]} {...hoverTitle(reachText)}>
          <OwnerFace face={ctx.faceOf(seat.owner)} size={16} />
          <Text variant="rowTitle" numberOfLines={1} style={styles.subName}>
            {title}
          </Text>
        </View>
        {headline === null ? null : headline.value === null ? (
          <Text variant="treeMeta" style={[styles.small, styles.subLine]} numberOfLines={1} testID="area-metric">
            {headline.label}
          </Text>
        ) : (
          <View
            style={[styles.subValueLine, styles.subLine]}
            testID="area-metric"
            accessibilityLabel={`${headline.label}: ${headline.value} ${headline.goal}${headline.verdict === null ? "" : `, ${headline.verdict.words}`}`}
            {...hoverTitle(`${headline.label}${headline.verdict === null ? "" : ` · ${headline.verdict.words}`}${headline.date === "" ? "" : `, ${headline.date}`}`)}
          >
            <Text variant="tree" style={[styles.value, { color: valueInk(colors, headline) }]} numberOfLines={1} testID="area-metric-value">
              {headline.value}
            </Text>
            <Text variant="treeMeta" style={styles.target} numberOfLines={1}>
              {headline.goal}
            </Text>
          </View>
        )}
      </Pressable>
      <More seat={seat} ctx={ctx} shown={hovered} onHover={() => setHovered(true)} style={styles.subMore} />
    </View>
  );
}

/** An empty seat: a dashed ring for a face, the name, and Assign owner. */
function EmptyBox({ seat, ctx, big = false }: { seat: Seat; ctx: Ctx; big?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const menuClick = useRightClick((at) => {
    ctx.onMenu(seat, at);
    return true;
  });
  return (
    <View style={[styles.empty, ctx.compact && styles.boxPhone]} testID={`area-box-${seat.folder}`} ref={menuClick.ref as never}>
      <Pressable onPress={() => ctx.onArea(seat.folder)} role="link" accessibilityLabel={`${areaTitle(seat.name)}, no owner`} style={styles.emptyName}>
        <View style={styles.ring} />
        <Text variant="rowTitle" numberOfLines={1} style={[styles.subName, styles.emptyTitle, big && styles.name]}>
          {areaTitle(seat.name)}
        </Text>
      </Pressable>
      {ctx.onAssign === null ? null : (
        <Pressable onPress={() => ctx.onAssign?.(seat)} role="button" style={styles.assign} testID={`area-assign-${seat.folder}`}>
          <Text variant="tree" style={styles.assignText}>
            Assign owner
          </Text>
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chart: { width: "100%" },
    muted: { color: colors.muted },
    small: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    look: { fontSize: pointerType.meta, lineHeight: 16, color: colors.warnText, fontWeight: "600" },

    org: { alignItems: "center", width: "100%" },
    orgRoot: { width: 240 },
    orgEmpty: { alignItems: "center", gap: 8, paddingTop: 16 },
    stem: { width: LINE, height: DROP, backgroundColor: colors.lineStrong },
    orgScroll: { width: "100%" },
    orgScrollInner: { flexGrow: 1, justifyContent: "center" },
    orgRow: { flexDirection: "row", alignItems: "flex-start", gap: COLUMN_GAP },
    column: { width: COLUMN, flexShrink: 0, paddingTop: DROP, position: "relative" },
    bus: { position: "absolute", top: 0, left: -COLUMN_GAP / 2, right: -COLUMN_GAP / 2, height: LINE, backgroundColor: colors.lineStrong },
    busFirst: { left: "50%" },
    busLast: { right: "50%" },
    drop: { position: "absolute", top: 0, left: "50%", width: LINE, height: DROP, backgroundColor: colors.lineStrong },
    sub: { position: "relative", marginTop: SUB_GAP, marginLeft: SUB_INSET },
    subSpine: { position: "absolute", left: -8, top: -SUB_GAP - 1, width: LINE, backgroundColor: colors.lineStrong },
    subSpineOn: { bottom: 0 },
    subSpineLast: { height: SUB_GAP + 1 + SUB_ELBOW + 1 },
    subElbow: { position: "absolute", left: -8, top: SUB_ELBOW, width: 8, height: LINE, backgroundColor: colors.lineStrong },

    kids: { position: "relative", paddingLeft: 20, marginTop: 16, gap: 8 },
    kidsDeep: { marginTop: 8 },
    spine: { position: "absolute", left: -10, width: LINE, backgroundColor: colors.lineStrong },
    spineOn: { bottom: 0 },
    elbow: { position: "absolute", left: -10, top: 25, width: 10, height: LINE, backgroundColor: colors.lineStrong },

    rootBox: { borderRadius: 10, backgroundColor: colors.rootSurface, paddingVertical: 10, paddingHorizontal: 12, gap: 6 },
    rootBoxPhone: { borderRadius: 18, padding: 16 },
    rootTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    rootName: { flexGrow: 1, flexShrink: 1, fontSize: areasType.value, lineHeight: 20, color: colors.text },
    rootOwner: { flexShrink: 1, fontSize: pointerType.meta, lineHeight: 16, color: colors.text2 },
    ownerRow: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },

    box: { position: "relative", backgroundColor: colors.cardSurface, borderWidth: 1, borderColor: colors.line, borderRadius: 10, minWidth: 0 },
    boxPhone: { borderRadius: 18 },
    boxHover: { borderColor: colors.lineStrong },
    body: { paddingVertical: 10, paddingHorizontal: 12, gap: 8 },
    bodyPhone: { padding: 16 },
    nameBlock: { gap: 2, paddingRight: 20 },
    nameRow: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
    name: { flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, color: colors.text },
    ownerText: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, paddingLeft: 24 },
    boxMetric: { gap: 3, minWidth: 0 },
    valueLine: { flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0 },
    value: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", flexShrink: 0 },
    bigValue: { fontSize: areasType.value + 4, lineHeight: areasType.value + 10, fontWeight: "700", flexShrink: 0 },
    target: { fontSize: pointerType.meta, lineHeight: 18, color: colors.muted, flexShrink: 1, minWidth: 0 },
    noReadings: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    fold: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    foldText: { flexShrink: 1 },
    more: { position: "absolute", top: 9, right: 9, padding: 0 },
    addSub: { position: "absolute", bottom: 8, right: 8, padding: 4, borderRadius: 6, backgroundColor: colors.chipFill },

    subBody: { paddingVertical: 8, paddingHorizontal: 10, gap: 3 },
    subNameRow: { paddingRight: 18 },
    subName: { flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, color: colors.text },
    subLine: { paddingLeft: 24 },
    subValueLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    subMore: { position: "absolute", top: 7, right: 8 },

    empty: { borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 8 },
    emptyName: { flexDirection: "row", alignItems: "center", gap: 8 },
    ring: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong },
    emptyTitle: { color: colors.muted },
    assign: { alignSelf: "flex-start", marginLeft: 24, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.chipFill },
    assignText: { fontSize: pointerType.ui, lineHeight: 18, color: colors.text, fontWeight: "600" },

    ghost: {
      height: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      borderRadius: 12,
    },
    ghostPhone: { marginTop: 12, borderRadius: 18 },
    ghostText: { fontSize: pointerType.ui, lineHeight: 18, color: colors.muted },
    addLine: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  });
