/**
 * The List view of an Areas folder, as the owner approved it on 2026-11-24
 * (the Areas redesign board, "E Trend"): one row per area, nested under the
 * open folder's own row. A row reads, left to right: a chevron when it has
 * sub-areas, its owner's face, its name; then its one headline metric (its
 * label over a small trend, the latest value in green or amber, and the
 * target); then a count of the notes and folders in it, which shows them
 * under the row; then ⋯ for the seat menu. Notes and folders are hidden until
 * that count is pressed (the owner: "maybe we just hide it? with a button to
 * show them").
 *
 * On a phone each area is a block: the name line with its count at the end,
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
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { areasType, pointerType } from "../../../../design/tokens";
import { displayName, folderLabel } from "../../paths";
import type { ItemEntry } from "../model";
import { OwnerFace, type Face } from "../Glyphs";
import { useRightClick } from "../../rightClick";
import { pressPoint } from "./pressPoint";
import type { Reading } from "./readings";
import { headlineOf } from "./headline";
import { MetricCell, PhoneMetric } from "./AreaMetricCell";
import { areaTitle, fileKind, type AreaNode, type Seat } from "./seat";
import type { AreaProjects } from "./areaProjects";
import { ProjectsButton, ProjectRows } from "./AreaProjectRows";

export { shortTarget } from "./shortTarget";

/** A web hover title; none on a phone. */
function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" && text !== "" ? { title: text } : {};
}

/** The counts column: the notes count alone, or the projects count beside it. */
const COUNTS = 52;
const COUNTS_WIDE = 100;
/** How far each level sits in from its parent: 20 on a pointer, 16 on a phone. */
const INDENT = 16;
const INDENT_PHONE = 16;
/** A file row sits under its area's name: the chevron and face columns past the area's own inset. */
const FILE_INSET = 52;
const FILE_INSET_PHONE = 26;

export interface AreasListProps {
  tree: AreaNode;
  compact: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  /** One line saying how to reach the owner, "" if unknown: web title and accessibilityHint on the owner face. */
  reach: (owner: string) => string;
  /** The name drawn on the top row: the workspace's name when the open folder is the Areas folder, else the area's own title. */
  rootTitle: string;
  /** How many notes a plain folder holds, at any depth. */
  notesUnder: (folder: string) => number;
  /** A file row opens the note; an area row opens that area's own page; a plain folder row opens the folder. */
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
  /** The projects that serve an area or its sub-areas (`areaProjects.ts`); absent where the Projects folder is not read. */
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
  /** Areas whose notes and folders are showing. */
  readonly shown: ReadonlySet<string>;
  readonly toggleNotes: (folder: string) => void;
  /** An area's projects, none where they are not read. */
  readonly projectsOf: (folder: string) => AreaProjects | null;
  /** Areas whose projects in progress are showing. */
  readonly shownProjects: ReadonlySet<string>;
  readonly toggleProjects: (folder: string) => void;
  /** The counts column: wider when some row has projects to count beside its notes. */
  readonly countsWidth: number;
}

const flip = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export function AreasList({ tree, compact, faceOf, label, reach, rootTitle, notesUnder, onOpen, onArea, selected = null, rootPeeks = false, onMenu, readingOf, projectsOf }: AreasListProps) {
  const styles = useThemedStyles(makeStyles);
  // Folders pressed away from their default: the top row starts open, every area under it starts
  // folded (the owner, 2026-11-25: "collapse the items not on the 1st level, by default on page open").
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [shownProjects, setShownProjects] = useState<ReadonlySet<string>>(() => new Set());
  const anyProjects = projectsOf !== undefined && someProjects(tree, projectsOf);
  const shared: Shared = {
    compact,
    faceOf,
    label,
    reach,
    notesUnder,
    onOpen,
    onArea: onArea ?? onOpen,
    selected,
    rootPeeks,
    onMenu,
    readingOf,
    isOpen: (folder) => (folder === tree.seat.folder) !== flipped.has(folder),
    toggle: (folder) => setFlipped((previous) => flip(previous, folder)),
    shown,
    toggleNotes: (folder) => setShown((previous) => flip(previous, folder)),
    projectsOf: (folder) => (projectsOf === undefined || folder === tree.seat.folder ? null : projectsOf(folder)),
    shownProjects,
    toggleProjects: (folder) => setShownProjects((previous) => flip(previous, folder)),
    countsWidth: anyProjects ? COUNTS_WIDE : COUNTS,
  };
  const empty = tree.areas.length === 0 && tree.files.length === 0;
  return (
    <View style={compact ? styles.listPhone : styles.list} testID="areas-list">
      {compact ? <PhoneHead seat={tree.seat} title={rootTitle} shared={shared} /> : null}
      {empty ? <Text variant="meta" style={styles.empty}>No areas here yet.</Text> : null}
      {compact ? (
        <>
          {tree.areas.map((sub, at) => (
            <PhoneBranch key={sub.seat.folder} node={sub} depth={1} first={at === 0} shared={shared} />
          ))}
          <FileRows node={tree} depth={0} shared={shared} />
        </>
      ) : (
        <AreaBranch node={tree} depth={0} rootTitle={rootTitle} firstTop shared={shared} />
      )}
    </View>
  );
}

/* ------------------------------ pointer: rows ------------------------------ */

/** An area row, then its notes and folders when they are showing, then its sub-areas unless folded. Depth 0 is the open folder. */
function AreaBranch({ node, depth, rootTitle, firstTop, shared }: { node: AreaNode; depth: number; rootTitle?: string; firstTop: boolean; shared: Shared }) {
  const open = shared.isOpen(node.seat.folder);
  return (
    <>
      <AreaRow node={node} depth={depth} title={rootTitle} open={open} divided={depth === 1 && !firstTop} shared={shared} />
      <AreaProjectRows node={node} depth={depth} shared={shared} />
      <FileRows node={node} depth={depth} shared={shared} />
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
            </View>
            <View style={styles.metricCell}>
              {headline === null ? null : <MetricCell headline={headline} />}
            </View>
            <View style={[styles.notesCell, { width: shared.countsWidth }]}>
              <AreaProjectsButton node={node} shared={shared} />
              <NotesButton node={node} shared={shared} />
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

/** Whether any area under the top row has a project in progress, which widens the counts column for all of them. */
function someProjects(node: AreaNode, projectsOf: (folder: string) => AreaProjects): boolean {
  return node.areas.some((sub) => projectsOf(sub.seat.folder).inProgress.length > 0 || someProjects(sub, projectsOf));
}

/** The count of an area's projects in progress, which shows them under its row; nothing when there are none. */
function AreaProjectsButton({ node, shared, phone = false }: { node: AreaNode; shared: Shared; phone?: boolean }) {
  const projects = shared.projectsOf(node.seat.folder);
  if (projects === null) return null;
  return (
    <ProjectsButton
      count={projects.inProgress.length}
      area={folderLabel(node.seat.name)}
      folder={node.seat.folder}
      open={shared.shownProjects.has(node.seat.folder)}
      phone={phone}
      onPress={() => shared.toggleProjects(node.seat.folder)}
    />
  );
}

/** An area's projects in progress, when its count has been pressed, and a line saying how many more there are. */
function AreaProjectRows({ node, depth, shared }: { node: AreaNode; depth: number; shared: Shared }) {
  const projects = shared.projectsOf(node.seat.folder);
  if (projects === null || !shared.shownProjects.has(node.seat.folder)) return null;
  const inset = shared.compact ? Math.max(depth - 1, 0) * INDENT_PHONE + FILE_INSET_PHONE : depth * INDENT + 4 + FILE_INSET;
  return <ProjectRows area={node.seat.folder} projects={projects} inset={inset} phone={shared.compact} faceOf={shared.faceOf} onOpen={shared.onOpen} />;
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

/** How many notes and folders sit in an area, which shows them under its row; nothing when there are none. */
function NotesButton({ node, shared, phone = false }: { node: AreaNode; shared: Shared; phone?: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const count = node.files.length;
  if (count === 0) return null;
  const { seat } = node;
  const open = shared.shown.has(seat.folder);
  const words = `${open ? "Hide" : "Show"} notes in ${folderLabel(seat.name)}`;
  return (
    <Pressable
      onPress={() => shared.toggleNotes(seat.folder)}
      accessibilityLabel={words}
      aria-expanded={open}
      hitSlop={4}
      style={({ hovered }: HoverState) => [phone ? styles.notesPhone : styles.notes, hovered && styles.notesHover]}
      testID={`area-notes-${seat.folder}`}
      {...hoverTitle(words)}
    >
      <Svg width={13} height={13} viewBox="0 0 12 12" aria-hidden>
        <Path d="M3 1.5h4l2 2v7H3z" fill="none" stroke={colors.muted} strokeWidth={1.2} strokeLinejoin="round" />
      </Svg>
      <Text variant="treeMeta" style={phone ? styles.notesCountPhone : styles.notesCount}>
        {String(count)}
      </Text>
      <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        <Svg width={10} height={10} viewBox="0 0 14 14" aria-hidden>
          <Path d="M5 3l4 4-4 4" fill="none" stroke={colors.muted} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
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

/** The icon a file row draws, by what the entry is. */
const KIND_ICON: Record<ReturnType<typeof fileKind>, IconName> = {
  folder: "folder",
  note: "file",
  page: "file",
  sheet: "grid",
  file: "file",
};

/** An area's notes and folders, when its count has been pressed. */
function FileRows({ node, depth, shared }: { node: AreaNode; depth: number; shared: Shared }) {
  if (!shared.shown.has(node.seat.folder)) return null;
  return (
    <>
      {node.files.map((file) => (
        <FileRow key={file.path} entry={file} depth={depth} shared={shared} />
      ))}
    </>
  );
}

function FileRow({ entry, depth, shared }: { entry: ItemEntry; depth: number; shared: Shared }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const kind = fileKind(entry);
  const folder = kind === "folder";
  const name = displayName(entry.name).replace(/\.page$/, "");
  const notes = folder ? shared.notesUnder(entry.path) : 0;
  const meta = kind === "sheet" ? "CSV" : kind === "page" ? "Page" : notes > 0 ? `${notes} ${notes === 1 ? "note" : "notes"}` : "";
  const inset = shared.compact ? Math.max(depth - 1, 0) * INDENT_PHONE + FILE_INSET_PHONE : depth * INDENT + 4 + FILE_INSET;
  return (
    <Pressable
      onPress={() => shared.onOpen(entry.path)}
      accessibilityLabel={folder ? `${name}, folder` : name}
      testID={`area-file-${entry.path}`}
      {...depthProps(depth + 1)}
      style={({ hovered }: HoverState) => [shared.compact ? styles.fileRowPhone : styles.fileRow, { paddingLeft: inset }, hovered && styles.hover]}
    >
      <View style={styles.fileIcon}>
        <Icon name={KIND_ICON[kind]} size={15} color={colors.muted} />
      </View>
      <Text variant="tree" style={[styles.fileName, shared.compact && styles.fileNamePhone]} numberOfLines={1}>
        {name}
      </Text>
      {meta === "" ? null : (
        <Text variant="treeMeta" style={styles.fileMeta} numberOfLines={1}>
          {meta}
        </Text>
      )}
    </Pressable>
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
          <AreaProjectsButton node={node} shared={shared} phone />
          <NotesButton node={node} shared={shared} phone />
        </View>
        <View style={styles.blockMetric}>
          {headline === null ? null : <PhoneMetric headline={headline} />}
        </View>
      </Pressable>
      <AreaProjectRows node={node} depth={depth} shared={shared} />
      <FileRows node={node} depth={depth} shared={shared} />
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

    // A row on the app's own scale (the owner, 2026-11-24: the board's 60-high rows read "way too big" in the app): name, 220 of metric and 52 of count, 16 apart; the ⋯ floats past the right edge.
    areaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      minHeight: 40,
      paddingVertical: 4,
      paddingRight: 12,
      borderRadius: 8,
    },
    divided: { borderTopWidth: 1, borderTopColor: colors.line, borderRadius: 0 },
    nameCell: { flexDirection: "row", alignItems: "center", gap: 8, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    chevron: { alignItems: "center", justifyContent: "center", borderRadius: 6, flexShrink: 0 },
    chevronPhone: { marginTop: -8, marginBottom: -8, marginLeft: -6, marginRight: -4 },
    areaName: { flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    rootName: { fontSize: areasType.value },
    unownedName: { color: colors.muted },
    metricCell: { width: 220, flexShrink: 0, minWidth: 0 },
    notesCell: { flexShrink: 0, flexDirection: "row", justifyContent: "flex-end", alignItems: "center" },
    more: { position: "absolute", right: -28, top: "50%", marginTop: -12, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 6 },


    notes: { flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 8, borderRadius: 6 },
    notesHover: { backgroundColor: colors.chipFill },
    notesCount: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "500", color: colors.muted },
    notesPhone: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, height: 28, minWidth: 44, paddingHorizontal: 10, borderRadius: 999, flexShrink: 0 },
    notesCountPhone: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "500", color: colors.muted },

    fileRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingRight: 12, borderRadius: 8 },
    fileRowPhone: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
    fileIcon: { width: 16, alignItems: "center", flexShrink: 0 },
    fileName: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, color: colors.text2 },
    fileNamePhone: { fontSize: areasType.value, lineHeight: 20 },
    fileMeta: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 0 },

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
    block: { paddingVertical: 8, gap: 4 },
    blockName: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
    blockTitle: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600", color: colors.text },
    blockMetric: { paddingLeft: 26, gap: 1, minWidth: 0 },
  });
