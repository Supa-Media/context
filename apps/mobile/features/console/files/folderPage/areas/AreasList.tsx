/**
 * The List view of an Areas folder: an outline rooted at the open area. Each
 * area is a row with its owner, its first metric's target and a dot that is
 * warm when its seat is missing something (`gapOf`); under it, the notes and
 * folders inside it, then its sub-areas. The page's own title is the root, so
 * the outline starts at the root's sub-areas. Presentational only: the tree
 * comes from `seat.ts` and every press goes out through a prop. The Chart view
 * reads the same tree.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type ViewProps } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { displayName, folderLabel } from "../../paths";
import type { ItemEntry } from "../model";
import { OwnerFace, type Face } from "../Glyphs";
import { gapOf, type AreaNode, type Seat } from "./seat";

/** How far each level sits in from its parent. */
const INDENT = 16;
/** The chevron's gutter, so a file's icon lines up under an area's dot. */
const GUTTER = 18;

export interface AreasListProps {
  tree: AreaNode;
  compact: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  /** One line saying how to reach the owner, "" if unknown: web title and accessibilityHint on the owner face. */
  reach: (owner: string) => string;
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

/** The shape of the DOM event a web context menu hands its handler. */
interface WebMouseEvent {
  pageX?: number;
  pageY?: number;
  preventDefault?: () => void;
}

/** Right-click on web, the way `TabStrip` wires it; nothing on native, which has no second button. */
function contextMenuProps(onMenu: (at: { x: number; y: number }) => void): ViewProps {
  if (Platform.OS !== "web") return {};
  return {
    onContextMenu: (event: WebMouseEvent) => {
      event.preventDefault?.();
      onMenu({ x: event.pageX ?? 0, y: event.pageY ?? 0 });
    },
  } as unknown as ViewProps;
}

/** Everything a row needs from the list, passed down once. */
interface Shared extends Omit<AreasListProps, "tree"> {
  readonly closed: ReadonlySet<string>;
  readonly toggle: (folder: string) => void;
}

export function AreasList({ tree, compact, faceOf, label, reach, onOpen, onMenu }: AreasListProps) {
  const styles = useThemedStyles(makeStyles);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (folder: string) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const shared: Shared = { compact, faceOf, label, reach, onOpen, onMenu, closed, toggle };
  const empty = tree.areas.length === 0 && tree.files.length === 0;
  return (
    <View style={styles.list} testID="areas-list">
      {empty ? <Text variant="meta" style={styles.empty}>No areas here yet.</Text> : null}
      {tree.areas.map((area) => (
        <AreaBranch key={area.seat.folder} node={area} depth={0} shared={shared} />
      ))}
      {tree.files.map((file) => (
        <FileRow key={file.path} entry={file} depth={0} onOpen={onOpen} />
      ))}
    </View>
  );
}

function AreaBranch({ node, depth, shared }: { node: AreaNode; depth: number; shared: Shared }) {
  const open = !shared.closed.has(node.seat.folder);
  return (
    <>
      <AreaRow seat={node.seat} depth={depth} open={open} shared={shared} />
      {open
        ? node.files.map((file) => <FileRow key={file.path} entry={file} depth={depth + 1} onOpen={shared.onOpen} />)
        : null}
      {open
        ? node.areas.map((sub) => <AreaBranch key={sub.seat.folder} node={sub} depth={depth + 1} shared={shared} />)
        : null}
    </>
  );
}

function AreaRow({ seat, depth, open, shared }: { seat: Seat; depth: number; open: boolean; shared: Shared }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const warm = gapOf(seat) !== null;
  const target = seat.metrics[0]?.target ?? "—";
  return (
    <View {...contextMenuProps((at) => shared.onMenu(seat, at))}>
      <Pressable
        onPress={() => shared.onOpen(seat.folder)}
        accessibilityLabel={`${folderLabel(seat.name)}, area`}
        testID={`area-row-${seat.folder}`}
        style={({ hovered }: HoverState) => [styles.row, shared.compact && styles.rowCompact, { paddingLeft: depth * INDENT }, hovered && styles.hover]}
      >
        {({ hovered }: HoverState) => (
          <>
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
            <View style={[styles.dot, { backgroundColor: warm ? colors.warn : colors.muted }]} />
            <Text variant="tree" style={styles.areaName} numberOfLines={1}>
              {folderLabel(seat.name)}
            </Text>
            <View style={styles.trail}>
              <OwnerMark owner={seat.owner} faceOf={shared.faceOf} label={shared.label} reach={shared.reach} />
              <Text variant="treeMeta" style={styles.target} numberOfLines={1}>
                {target}
              </Text>
              <Pressable
                onPress={(event: GestureResponderEvent) => shared.onMenu(seat, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
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

function FileRow({ entry, depth, onOpen }: { entry: ItemEntry; depth: number; onOpen: (path: string) => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const folder = entry.kind === "folder";
  const name = displayName(entry.name);
  const csv = !folder && /\.csv$/i.test(entry.name);
  return (
    <Pressable
      onPress={() => onOpen(entry.path)}
      accessibilityLabel={folder ? `${name}, folder` : name}
      testID={`area-file-${entry.path}`}
      style={({ hovered }: HoverState) => [styles.row, { paddingLeft: depth * INDENT }, hovered && styles.hover]}
    >
      <View style={styles.gutter} />
      <Icon name={folder ? "folder" : "file"} size={15} color={colors.chromeMuted} />
      <Text variant="tree" style={styles.fileName} numberOfLines={1}>
        {name}
      </Text>
      {csv ? (
        <Text variant="treeMeta" style={styles.tag}>
          CSV
        </Text>
      ) : null}
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
    rowCompact: { minHeight: 44 },
    hover: { backgroundColor: colors.surface3 },
    gutter: { width: GUTTER, height: 22, alignItems: "center", justifyContent: "center" },
    dot: { width: 6, height: 6, borderRadius: radii.pill, flexShrink: 0 },
    areaName: { flexShrink: 1, flexGrow: 1, minWidth: 0, fontWeight: "600", color: colors.text },
    trail: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 0, marginLeft: "auto" as never },
    target: { color: colors.muted, maxWidth: 140 },
    more: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
    moreShown: { opacity: 1 },
    moreHidden: { opacity: 0 },
    fileName: { flexShrink: 1, flexGrow: 1, minWidth: 0, color: colors.muted },
    tag: {
      color: colors.chromeMuted,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      paddingHorizontal: space.x1,
    },
  });
