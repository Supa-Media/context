/**
 * The List view of an Areas folder: an outline rooted at the open folder. The
 * top row is the open folder itself, drawn as an area row (its name is
 * `rootTitle`, its ⋯ opens the seat menu, its chevron folds everything).
 * Everything else nests under it: sub-areas first, then up to three files per
 * area with a "Show N more" row for the rest. Each area row carries its owner,
 * a value, and a dot that is warm when its seat is missing something (`gapOf`).
 * Guide lines run down the left so the levels read as one tree.
 *
 * Presentational only: the tree comes from `seat.ts` and every press goes out
 * through a prop. The Chart view reads the same tree.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type ViewProps } from "react-native";
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { displayName, folderLabel } from "../../paths";
import type { ItemEntry } from "../model";
import { OwnerFace, type Face } from "../Glyphs";
import { useRightClick } from "../../rightClick";
import { pressPoint } from "./pressPoint";
import { areaTitle, fileKind, gapOf, healthOf, type AreaNode, type Seat } from "./seat";

/** How far each level sits in from its parent. */
const INDENT = 16;
/** The chevron's gutter, so a file's icon lines up under an area's dot. */
const GUTTER = 18;
/** The most file rows an area shows before "Show N more". */
const FILES_SHOWN = 3;

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
  /** Right-click on an area row, or its ⋯ button (`at` null). */
  onMenu: (seat: Seat, at: { x: number; y: number } | null) => void;
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
interface Shared extends Omit<AreasListProps, "tree" | "rootTitle"> {
  readonly closed: ReadonlySet<string>;
  readonly toggle: (folder: string) => void;
}

export function AreasList({ tree, compact, faceOf, label, reach, rootTitle, notesUnder, onOpen, onMenu }: AreasListProps) {
  const styles = useThemedStyles(makeStyles);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (folder: string) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const shared: Shared = { compact, faceOf, label, reach, notesUnder, onOpen, onMenu, closed, toggle };
  const empty = tree.areas.length === 0 && tree.files.length === 0;
  return (
    <View style={styles.list} testID="areas-list">
      {empty ? <Text variant="meta" style={styles.empty}>No areas here yet.</Text> : null}
      <AreaBranch node={tree} depth={0} rootTitle={rootTitle} shared={shared} />
    </View>
  );
}

/** An area row, then (when open) its sub-areas and its files. Depth 0 is the open folder, drawn as `rootTitle`. */
function AreaBranch({ node, depth, rootTitle, shared }: { node: AreaNode; depth: number; rootTitle?: string; shared: Shared }) {
  const open = !shared.closed.has(node.seat.folder);
  // Per area: whether its file list is showing every file, not just the first few.
  const [allFiles, setAllFiles] = useState(false);
  const files = allFiles ? node.files : node.files.slice(0, FILES_SHOWN);
  const hidden = node.files.length - files.length;
  const fileDepth = depth + 1;
  return (
    <>
      <AreaRow seat={node.seat} depth={depth} title={rootTitle} open={open} shared={shared} />
      {open
        ? node.areas.map((sub) => <AreaBranch key={sub.seat.folder} node={sub} depth={fileDepth} shared={shared} />)
        : null}
      {open
        ? files.map((file) => <FileRow key={file.path} entry={file} depth={fileDepth} shared={shared} />)
        : null}
      {open && node.files.length > FILES_SHOWN ? (
        <MoreFiles
          folder={node.seat.folder}
          depth={fileDepth}
          shown={allFiles}
          count={hidden}
          onToggle={() => setAllFiles((value) => !value)}
          shared={shared}
        />
      ) : null}
    </>
  );
}

/** The guide lines for a row at `depth`: one 1px vertical per level, so the rows' lines join into continuous verticals. */
function Guides({ depth }: { depth: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {Array.from({ length: depth }, (_, index) => index + 1).map((level) => (
        <View
          key={level}
          testID="area-guide"
          style={[styles.guide, { left: level * INDENT - 4 }]}
        />
      ))}
    </>
  );
}

function AreaRow({ seat, depth, title, open, shared }: { seat: Seat; depth: number; title?: string; open: boolean; shared: Shared }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const root = depth === 0;
  const health = healthOf(seat);
  const warm = gapOf(seat) !== null;
  const unowned = seat.owner === null;
  const name = root ? (title ?? areaTitle(seat.name)) : areaTitle(seat.name);
  const openMenu = (at: { x: number; y: number } | null) => shared.onMenu(seat, at);
  const menuClick = useRightClick((at) => {
    openMenu(at);
    return true;
  });
  return (
    <View ref={menuClick.ref as never}>
      <Pressable
        onPress={() => (root ? openMenu(null) : shared.onOpen(seat.folder))}
        accessibilityLabel={root ? `${folderLabel(seat.name)}, seat` : `${folderLabel(seat.name)}, area`}
        testID={root ? "area-row-root" : `area-row-${seat.folder}`}
        {...depthProps(depth)}
        style={({ hovered }: HoverState) => [
          styles.row,
          styles.areaRow,
          shared.compact && styles.rowCompact,
          { paddingLeft: depth * INDENT },
          hovered && styles.hover,
        ]}
      >
        {({ hovered }: HoverState) => (
          <>
            <Guides depth={depth} />
            <Pressable
              onPress={() => shared.toggle(seat.folder)}
              accessibilityLabel={open ? `Close ${folderLabel(seat.name)}` : `Open ${folderLabel(seat.name)} here`}
              aria-expanded={open}
              hitSlop={6}
              style={styles.gutter}
              testID={`area-toggle-${seat.folder}`}
            >
              <Icon name={open ? "chevronDown" : "chevronRight"} size={15} color={colors.muted} />
            </Pressable>
            <HealthDot health={health} />
            <Text variant="tree" style={[styles.areaName, unowned && styles.unownedName]} numberOfLines={1}>
              {name}
            </Text>
            <View style={styles.trail}>
              <OwnerMark owner={seat.owner} faceOf={shared.faceOf} label={shared.label} reach={shared.reach} />
              <Text variant="treeMeta" style={styles.value} numberOfLines={1}>
                {unowned ? "No owner" : "—"}
              </Text>
              {warm ? <View testID="area-gap-dot" style={[styles.dot, { backgroundColor: colors.warn }]} /> : null}
              <Pressable
                onPress={(event: GestureResponderEvent) => openMenu(pressPoint(event))}
                accessibilityLabel={`Options for ${folderLabel(seat.name)}`}
                hitSlop={6}
                style={[styles.more, shared.compact || hovered ? styles.moreShown : styles.moreHidden]}
                testID={`area-more-${seat.folder}`}
              >
                <Icon name="more" size={15} color={colors.muted} />
              </Pressable>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}

/** The status dot: an empty dashed ring with no owner, amber when something is missing, else quiet. */
function HealthDot({ health }: { health: "ring" | "warn" | "neutral" }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const look =
    health === "ring"
      ? [styles.dot, styles.ring, { borderColor: colors.lineStrong }]
      : [styles.dot, { backgroundColor: health === "warn" ? colors.warn : colors.muted }];
  return <View testID={`area-dot-${health}`} style={look} />;
}

/** The owner's face, with the owner's name and how to reach them on hover and to a screen reader. */
function OwnerMark({
  owner,
  faceOf,
  label,
  reach,
}: {
  owner: string | null;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  reach: (owner: string) => string;
}) {
  const hint = owner === null ? "" : reach(owner);
  const webTitle = Platform.OS === "web" && hint !== "" ? ({ title: hint } as unknown as ViewProps) : {};
  return (
    <View
      accessibilityLabel={owner === null ? "Nobody" : label(owner)}
      accessibilityHint={hint === "" ? undefined : hint}
      testID="area-owner"
      {...webTitle}
    >
      <OwnerFace face={faceOf(owner)} size={16} />
    </View>
  );
}

/** The icon a file row draws, by what the entry is. The icon set has no page mark, so a page draws the file mark and its "Page" tag says what it is. */
const KIND_ICON: Record<ReturnType<typeof fileKind>, IconName> = {
  folder: "folder",
  note: "file",
  page: "file",
  sheet: "grid",
  file: "file",
};

function FileRow({ entry, depth, shared }: { entry: ItemEntry; depth: number; shared: Shared }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const kind = fileKind(entry);
  const folder = kind === "folder";
  const name = displayName(entry.name).replace(/\.page$/, "");
  const notes = folder ? shared.notesUnder(entry.path) : 0;
  return (
    <Pressable
      onPress={() => shared.onOpen(entry.path)}
      accessibilityLabel={folder ? `${name}, folder` : name}
      testID={`area-file-${entry.path}`}
      {...depthProps(depth)}
      style={({ hovered }: HoverState) => [
        styles.row,
        shared.compact && styles.rowCompact,
        { paddingLeft: depth * INDENT },
        hovered && styles.hover,
      ]}
    >
      <Guides depth={depth} />
      <View style={styles.gutter}>{folder ? <Icon name="chevronRight" size={13} color={colors.muted} /> : null}</View>
      <Icon name={KIND_ICON[kind]} size={15} color={colors.chromeMuted} />
      <Text variant="tree" style={styles.fileName} numberOfLines={1}>
        {name}
      </Text>
      {kind === "sheet" || kind === "page" ? (
        <Text variant="treeMeta" style={styles.tag}>
          {kind === "sheet" ? "CSV" : "Page"}
        </Text>
      ) : null}
      {notes > 0 ? (
        <Text variant="treeMeta" style={styles.meta} numberOfLines={1}>
          {`${notes} ${notes === 1 ? "note" : "notes"}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** "Show N more" under an area's first files, and "Show fewer" once every file is showing. */
function MoreFiles({
  folder,
  depth,
  shown,
  count,
  onToggle,
  shared,
}: {
  folder: string;
  depth: number;
  shown: boolean;
  count: number;
  onToggle: () => void;
  shared: Shared;
}) {
  const styles = useThemedStyles(makeStyles);
  const text = shown ? "Show fewer" : `Show ${count} more`;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityLabel={`${text} in ${folderLabel(folder)}`}
      testID={`area-more-files-${folder}`}
      {...depthProps(depth)}
      style={({ hovered }: HoverState) => [styles.row, shared.compact && styles.rowCompact, { paddingLeft: depth * INDENT }, hovered && styles.hover]}
    >
      <Guides depth={depth} />
      <View style={styles.gutter} />
      <Text variant="treeMeta" style={styles.meta}>
        {text}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingVertical: space.x1 },
    empty: { color: colors.muted, paddingHorizontal: space.x4, paddingVertical: space.x3 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 36,
      paddingRight: space.x3,
      borderRadius: radii.md,
    },
    areaRow: { minHeight: 40 },
    rowCompact: { minHeight: 44 },
    hover: { backgroundColor: colors.surface3 },
    guide: { position: "absolute", top: 0, bottom: 0, width: 1, backgroundColor: colors.line, pointerEvents: "none" },
    gutter: { width: GUTTER, height: 22, alignItems: "center", justifyContent: "center" },
    dot: { width: 6, height: 6, borderRadius: radii.pill, flexShrink: 0 },
    ring: { backgroundColor: "transparent", borderWidth: 1, borderStyle: "dashed" },
    areaName: { flexShrink: 1, flexGrow: 1, minWidth: 0, fontWeight: "600", color: colors.text },
    unownedName: { color: colors.muted },
    trail: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 0, marginLeft: "auto" as never },
    value: { width: 64, textAlign: "right", color: colors.muted },
    more: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
    moreShown: { opacity: 1 },
    moreHidden: { opacity: 0 },
    fileName: { flexShrink: 1, flexGrow: 1, minWidth: 0, color: colors.muted },
    meta: { color: colors.muted, flexShrink: 0 },
    tag: {
      color: colors.chromeMuted,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.sm,
      paddingHorizontal: space.x1,
      paddingVertical: 2,
    },
  });
