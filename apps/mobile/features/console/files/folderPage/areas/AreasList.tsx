/**
 * The List view of an Areas folder, trimmed for people who do not live in the
 * numbers (the owner, 2026-11-26, option A of the simplified Areas page; the
 * row's first shape was the Areas redesign board's "E Trend", 2026-11-24):
 * one row per area, nested under the open folder's own row, with sub-areas
 * folded until their chevron is pressed. A row reads, left to right: the
 * chevron and how many areas are inside, its owner's face, its name; then its
 * one metric as `186 aim 100+ · Weekly deploys`, the number green or yellow by
 * its verdict (`verdict.ts`); then how many of its projects are in progress,
 * in the same green or yellow, which unfolds them under the row (the owner,
 * 2026-11-26: "instead of exceeds targets etc, just show x projects"); then
 * ⋯ on hover for the seat menu. The verdict's words are on the hover tip, the
 * count's spoken label and the side panel, with the trend and time range.
 *
 * On a phone each area is a block: the name line with its projects at the end,
 * and the metric on a second line under it; the open folder is a small
 * heading over the list.
 *
 * Presentational only: the tree comes from `seat.ts`, the reading from the
 * page, and every press goes out through a prop. The Chart view reads the
 * same tree.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type ViewProps } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { areasType, pointerType } from "../../../../design/tokens";
import { folderLabel } from "../../paths";
import { OwnerFace, type Face } from "../Glyphs";
import { useRightClick } from "../../rightClick";
import { pressPoint } from "./pressPoint";
import type { Reading } from "./readings";
import type { Verdict } from "./verdict";
import { headlineOf } from "./headline";
import { MetricCell, PhoneMetric } from "./AreaMetricCell";
import { ProjectRows, ProjectsButton } from "./AreaProjectCount";
import type { AreaProjects } from "./areaProjects";
import { areaTitle, type AreaNode, type Seat } from "./seat";

export { shortTarget } from "./shortTarget";

/** The projects column: wide enough for "12 projects" and its chevron. */
const PROJECTS = 132;
/** How far each level sits in from its parent. */
const INDENT = 16;
const INDENT_PHONE = 16;

export interface AreasListProps {
  tree: AreaNode;
  compact: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  /** One line saying how to reach the owner, "" if unknown: web title and accessibilityHint on the owner face. */
  reach: (owner: string) => string;
  /** The name drawn on the top row: the workspace's name when the open folder is the Areas folder, else the area's own title. */
  rootTitle: string;
  /** An area row opens that area's own page (a phone's press). */
  onOpen: (path: string) => void;
  /** An area row pressed: the side panel on a desktop (a second press opens it), else its page. Defaults to `onOpen`. */
  onArea?: (folder: string) => void;
  /** The area shown in the side panel, drawn selected; null when none. */
  selected?: string | null;
  /** A press on the top row shows it in the side panel too, rather than opening its menu (the owner, 2026-11-24). */
  rootPeeks?: boolean;
  /** Right-click on an area row, or its ⋯ button (`at` null). */
  onMenu: (seat: Seat, at: { x: number; y: number } | null) => void;
  /** The latest reading of a seat's headline metric, a workspace metric's or its `metrics.csv`'s; undefined when there is none. */
  readingOf: (seat: Seat) => Reading | undefined;
  /** The projects that serve an area, grouped by status; absent while the Projects folder is unread. */
  projectsOf?: (folder: string) => AreaProjects;
}

/** The pointer state a web Pressable reports, which react-native-web adds to RN's. */
interface HoverState {
  readonly hovered?: boolean;
  readonly pressed: boolean;
}

/** The row's depth as a data attribute on web (react-native-web's `dataSet`), so a test and a page reader can see the level. */
function depthProps(depth: number): ViewProps {
  return { dataSet: { depth: String(depth) } } as unknown as ViewProps;
}

/** Everything a row needs from the list, passed down once. */
interface Shared extends Omit<AreasListProps, "tree" | "rootTitle" | "onArea" | "selected" | "rootPeeks" | "projectsOf"> {
  readonly rootPeeks: boolean;
  readonly onArea: (folder: string) => void;
  readonly selected: string | null;
  /** Whether an area's sub-areas are showing: the top row's are on open, every other area's are folded until its chevron is pressed. */
  readonly isOpen: (folder: string) => boolean;
  readonly toggle: (folder: string) => void;
  /** An area's projects; null for the top row and while unread. */
  readonly projectsOf: (folder: string) => AreaProjects | null;
  /** Whether an area's projects are unfolded under its row, and the press that flips it. */
  readonly projectsOpen: (folder: string) => boolean;
  readonly toggleProjects: (folder: string) => void;
}

const flip = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export function AreasList({ tree, compact, faceOf, label, reach, rootTitle, onOpen, onArea, selected = null, rootPeeks = false, onMenu, readingOf, projectsOf }: AreasListProps) {
  const styles = useThemedStyles(makeStyles);
  // Folders pressed away from their default: the top row starts open, every area under it starts
  // folded (the owner, 2026-11-25: "collapse the items not on the 1st level, by default on page open").
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const [projectsShown, setProjectsShown] = useState<ReadonlySet<string>>(() => new Set());
  const shared: Shared = {
    compact,
    faceOf,
    label,
    reach,
    onOpen,
    onArea: onArea ?? onOpen,
    selected,
    rootPeeks,
    onMenu,
    readingOf,
    isOpen: (folder) => (folder === tree.seat.folder) !== flipped.has(folder),
    toggle: (folder) => setFlipped((previous) => flip(previous, folder)),
    projectsOf: (folder) => (projectsOf === undefined || folder === tree.seat.folder ? null : projectsOf(folder)),
    projectsOpen: (folder) => projectsShown.has(folder),
    toggleProjects: (folder) => setProjectsShown((previous) => flip(previous, folder)),
  };
  const empty = tree.areas.length === 0;
  return (
    <View style={compact ? styles.listPhone : styles.list} testID="areas-list">
      {compact ? <PhoneHead seat={tree.seat} title={rootTitle} shared={shared} /> : null}
      {empty ? <Text variant="meta" style={styles.empty}>No areas here yet.</Text> : null}
      {compact ? (
        tree.areas.map((sub, at) => <PhoneBranch key={sub.seat.folder} node={sub} depth={1} first={at === 0} shared={shared} />)
      ) : (
        <AreaBranch node={tree} depth={0} rootTitle={rootTitle} firstTop shared={shared} />
      )}
    </View>
  );
}

/* ------------------------------ pointer: rows ------------------------------ */

/** An area row, then its sub-areas unless folded. Depth 0 is the open folder. */
function AreaBranch({ node, depth, rootTitle, firstTop, shared }: { node: AreaNode; depth: number; rootTitle?: string; firstTop: boolean; shared: Shared }) {
  const open = shared.isOpen(node.seat.folder);
  return (
    <>
      <AreaRow node={node} depth={depth} title={rootTitle} open={open} divided={depth === 1 && !firstTop} shared={shared} />
      <UnfoldedProjects node={node} inset={(depth + 1) * INDENT + 30} phone={false} shared={shared} />
      {open
        ? node.areas.map((sub, at) => <AreaBranch key={sub.seat.folder} node={sub} depth={depth + 1} firstTop={at === 0} shared={shared} />)
        : null}
    </>
  );
}

function AreaRow({ node, depth, title, open, divided, shared }: { node: AreaNode; depth: number; title?: string; open: boolean; divided: boolean; shared: Shared }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { seat } = node;
  const root = depth === 0;
  const name = root ? (title ?? areaTitle(seat.name)) : areaTitle(seat.name);
  const headline = headlineOf(seat, shared.readingOf(seat));
  const openMenu = (at: { x: number; y: number } | null) => shared.onMenu(seat, at);
  const menuClick = useRightClick((at) => {
    openMenu(at);
    return true;
  });
  return (
    <View ref={menuClick.ref as never}>
      <Pressable
        onPress={(event: GestureResponderEvent) => (root && !shared.rootPeeks ? openMenu(pressPoint(event)) : shared.onArea(seat.folder))}
        accessibilityLabel={root ? `${folderLabel(seat.name)}, seat` : `${folderLabel(seat.name)}, area`}
        testID={root ? "area-row-root" : `area-row-${seat.folder}`}
        {...depthProps(depth)}
        aria-selected={shared.selected === seat.folder}
        style={({ hovered }: HoverState) => [styles.areaRow, { paddingLeft: depth * INDENT + 4 }, divided && styles.divided, hovered && styles.hover, shared.selected === seat.folder && styles.selected]}
      >
        {({ hovered }: HoverState) => (
          <>
            <View style={styles.nameCell}>
              <Chevron node={node} open={open} size={18} shared={shared} />
              <OwnerMark owner={seat.owner} size={18} shared={shared} />
              <Text variant="tree" style={[styles.areaName, root && styles.rootName, seat.owner === null && styles.unownedName]} numberOfLines={1}>
                {name}
              </Text>
              <InsideCount node={node} />
            </View>
            <View style={styles.metricCell}>
              {headline === null ? null : <MetricCell headline={headline} />}
            </View>
            <View style={styles.projectsCell}>
              <AreaProjectsCount node={node} verdict={headline?.verdict ?? null} phone={false} shared={shared} />
            </View>
            {/* In the margin past the row's right edge, on hover only, so it takes no room from the
                row (the owner, 2026-11-24: "remove the deadspace"). The top row's own press opens the menu. */}
            {root ? null : (
              <Pressable
                onPress={(event: GestureResponderEvent) => openMenu(pressPoint(event))}
                accessibilityLabel={`Options for ${folderLabel(seat.name)}`}
                hitSlop={6}
                style={[styles.more, { opacity: hovered ? 1 : 0 }]}
                testID={`area-more-${seat.folder}`}
              >
                <Icon name="more" size={14} color={colors.muted} />
              </Pressable>
            )}
          </>
        )}
      </Pressable>
    </View>
  );
}

/** How many of an area's projects are in progress, in its verdict's colour; nothing when none are or they are unread. */
function AreaProjectsCount({ node, verdict, phone, shared }: { node: AreaNode; verdict: Verdict | null; phone: boolean; shared: Shared }) {
  const { seat } = node;
  const projects = shared.projectsOf(seat.folder);
  if (projects === null) return null;
  return (
    <ProjectsButton
      count={projects.inProgress.length}
      area={folderLabel(seat.name)}
      folder={seat.folder}
      verdict={verdict}
      open={shared.projectsOpen(seat.folder)}
      phone={phone}
      onPress={() => shared.toggleProjects(seat.folder)}
    />
  );
}

/** An area's projects in progress under its row, while its count is pressed open. */
function UnfoldedProjects({ node, inset, phone, shared }: { node: AreaNode; inset: number; phone: boolean; shared: Shared }) {
  const { seat } = node;
  const projects = shared.projectsOf(seat.folder);
  if (projects === null || !shared.projectsOpen(seat.folder) || projects.inProgress.length === 0) return null;
  return <ProjectRows area={seat.folder} projects={projects} inset={inset} phone={phone} faceOf={shared.faceOf} onOpen={shared.onOpen} />;
}

/** How many areas are inside, beside the name, muted; nothing when there are none. */
function InsideCount({ node }: { node: AreaNode }) {
  const styles = useThemedStyles(makeStyles);
  if (node.areas.length === 0) return null;
  return (
    <Text variant="treeMeta" style={styles.inside} testID={`area-inside-${node.seat.folder}`} accessibilityLabel={`${node.areas.length} areas inside`}>
      {String(node.areas.length)}
    </Text>
  );
}

/** The chevron that folds an area's sub-areas, or the same width of nothing when it has none. */
function Chevron({ node, open, size, shared, phone = false }: { node: AreaNode; open: boolean; size: number; shared: Shared; phone?: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { seat } = node;
  if (node.areas.length === 0) return <View style={{ width: phone ? 18 : size, flexShrink: 0 }} />;
  return (
    <Pressable
      onPress={() => shared.toggle(seat.folder)}
      accessibilityLabel={open ? `Hide areas in ${folderLabel(seat.name)}` : `Show areas in ${folderLabel(seat.name)}`}
      aria-expanded={open}
      hitSlop={6}
      style={[styles.chevron, { width: size, height: size }, phone && styles.chevronPhone]}
      testID={`area-toggle-${seat.folder}`}
    >
      <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        <Svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
          <Path d="M5 3l4 4-4 4" fill="none" stroke={colors.muted} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Pressable>
  );
}

/** The owner's face, with the owner's name and how to reach them on hover and to a screen reader. */
function OwnerMark({ owner, size, shared }: { owner: string | null; size: number; shared: Shared }) {
  const hint = owner === null ? "" : shared.reach(owner);
  const webTitle = Platform.OS === "web" ? ({ title: owner === null ? "No owner" : hint === "" ? shared.label(owner) : `${shared.label(owner)} · ${hint}` } as unknown as ViewProps) : {};
  return (
    <View
      accessibilityLabel={owner === null ? "No owner" : shared.label(owner)}
      accessibilityHint={hint === "" ? undefined : hint}
      testID="area-owner"
      style={{ flexShrink: 0 }}
      {...webTitle}
    >
      <OwnerFace face={shared.faceOf(owner)} size={size} />
    </View>
  );
}

/* ------------------------------ phone: blocks ------------------------------ */

/** The open folder on a phone: its name, small and spaced, and its owner's face, over a rule. Pressing it opens the seat menu. */
function PhoneHead({ seat, title, shared }: { seat: Seat; title: string; shared: Shared }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={(event: GestureResponderEvent) => shared.onMenu(seat, pressPoint(event))}
      onLongPress={(event: GestureResponderEvent) => shared.onMenu(seat, pressPoint(event))}
      accessibilityLabel={`${folderLabel(seat.name)}, seat`}
      style={styles.phoneHead}
      testID="area-row-root"
      {...depthProps(0)}
    >
      <Text variant="treeMeta" style={styles.phoneHeadName} numberOfLines={1}>
        {title}
      </Text>
      <OwnerMark owner={seat.owner} size={18} shared={shared} />
    </Pressable>
  );
}

function PhoneBranch({ node, depth, first, shared }: { node: AreaNode; depth: number; first: boolean; shared: Shared }) {
  const styles = useThemedStyles(makeStyles);
  const { seat } = node;
  const open = shared.isOpen(seat.folder);
  const headline = headlineOf(seat, shared.readingOf(seat));
  const openMenu = (event: GestureResponderEvent) => shared.onMenu(seat, pressPoint(event));
  return (
    <>
      <Pressable
        onPress={() => shared.onOpen(seat.folder)}
        onLongPress={openMenu}
        accessibilityLabel={`${folderLabel(seat.name)}, area`}
        testID={`area-row-${seat.folder}`}
        {...depthProps(depth)}
        style={[styles.block, { paddingLeft: (depth - 1) * INDENT_PHONE }, depth === 1 && !first && styles.divided]}
      >
        <View style={styles.blockName}>
          <Chevron node={node} open={open} size={28} shared={shared} phone />
          <OwnerMark owner={seat.owner} size={22} shared={shared} />
          <Text variant="treeTouch" style={[styles.blockTitle, seat.owner === null && styles.unownedName]} numberOfLines={1}>
            {areaTitle(seat.name)}
          </Text>
          <InsideCount node={node} />
          <View style={styles.blockProjects}>
            <AreaProjectsCount node={node} verdict={headline?.verdict ?? null} phone shared={shared} />
          </View>
        </View>
        {headline === null ? null : (
          <View style={styles.blockMetric}>
            <PhoneMetric headline={headline} />
          </View>
        )}
      </Pressable>
      <UnfoldedProjects node={node} inset={(depth - 1) * INDENT_PHONE + 18} phone shared={shared} />
      {open ? node.areas.map((sub) => <PhoneBranch key={sub.seat.folder} node={sub} depth={depth + 1} first={false} shared={shared} />) : null}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingVertical: 4 },
    listPhone: { paddingBottom: 8 },
    empty: { color: colors.muted, paddingHorizontal: 16, paddingVertical: 12 },
    hover: { backgroundColor: colors.chipFill },
    // The area shown in the side panel.
    selected: { backgroundColor: colors.accentDim },

    // A row on the app's own scale (the owner, 2026-11-24: the board's 60-high rows read "way too big" in the app): name, metric and verdict, 16 apart; the ⋯ floats past the right edge.
    areaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      minHeight: 44,
      paddingVertical: 6,
      paddingRight: 12,
      borderRadius: 8,
    },
    divided: { borderTopWidth: 1, borderTopColor: colors.line, borderRadius: 0 },
    nameCell: { flexDirection: "row", alignItems: "center", gap: 8, flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    chevron: { alignItems: "center", justifyContent: "center", borderRadius: 6, flexShrink: 0 },
    chevronPhone: { marginTop: -8, marginBottom: -8, marginLeft: -6, marginRight: -4 },
    areaName: { flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    rootName: { fontSize: areasType.value },
    unownedName: { color: colors.muted },
    inside: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 0 },
    metricCell: { flexGrow: 3, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    projectsCell: { width: PROJECTS, flexShrink: 0, minWidth: 0 },
    more: { position: "absolute", right: -28, top: "50%", marginTop: -12, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 6 },

    phoneHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 22,
      marginBottom: 4,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    phoneHeadName: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase", color: colors.muted },
    block: { paddingVertical: 10, gap: 4 },
    blockName: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
    blockTitle: { flexShrink: 1, minWidth: 0, fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600", color: colors.text },
    blockProjects: { marginLeft: "auto", flexShrink: 0, paddingLeft: 8 },
    blockMetric: { paddingLeft: 26, gap: 1, minWidth: 0 },
  });
