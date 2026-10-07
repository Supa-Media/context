import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, leading, radii, space, touchType, tracking } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import {
  buildHome,
  countLabel,
  whenLabel,
  type HomeFolder,
  type HomeNoteTile,
  type HomeOpened,
  type HomePin,
  type HomeRecent,
} from "./homeModel";
import type { HomeSource } from "./useHomeSource";
import { useHomeTag } from "./homeTag";

const whenOf = (at: number | undefined, now: number) => (at === undefined ? "" : whenLabel(at, now));

/**
 * The phone's Home: the workspace's own page, Apple Notes style.
 *
 * Approved by the owner on 2026-09-30 (the mobile Home artboards, board 01).
 * Top to bottom: the workspace's name and size with a New folder button,
 * **Pinned** tiles, a **You open most** rail, the three most **Recent**
 * notes, **All folders** with what each holds, then the **Notes** outside every folder — Home is the only page
 * that lists those, so without it they would be out of reach. Search and a new note are the bottom bar's (`ConsoleBottomBar`),
 * on every screen, so this page has neither.
 *
 * What goes in each section is `homeModel.ts`'s, from the device's copy of the
 * workspace and the person's own places; this file only draws it. The tag
 * chips the board drew are gone (owner's team, 2026-10-05; `homeModel.ts`
 * says why): a tag opened from search shows as one "Tagged" line with a way
 * back to everything, over the notes that carry it. It renders
 * where the phone used to draw the workspace's root folder listing, so a
 * visitor on the homepage gets it too, with no pins and no opens.
 */
export function PhoneHome({
  title,
  source,
  pins,
  opened,
  recents,
  onShown,
  onOpen,
  onNewFolder,
  onActions,
  onTogglePin,
  foot,
  onOpenMap,
}: {
  title: string;
  source: HomeSource;
  pins: readonly HomePin[];
  opened: readonly HomeOpened[];
  /** This person's own recent notes; `null` for a visitor, who has no account. */
  recents: readonly HomeRecent[] | null;
  /** Home came on screen: read the person's places again, written on any device since. */
  onShown?: () => void;
  onOpen: (path: string) => void;
  /** `undefined` for who may not make folders here. */
  onNewFolder?: () => void;
  /** The workspace's own ••• sheet (New note, New folder, Share, Download). */
  onActions?: (anchor: { x: number; y: number }) => void;
  /** Held on a tile or row: pin it, or unpin it. `null` without an account. */
  onTogglePin: ((path: string, kind: "note" | "folder") => void) | null;
  /** The workspace's storage line, as the root listing had it. */
  foot?: string;
  /** The live map, a place of its own on Home. `undefined` where there is none (a visitor, the demo). */
  onOpenMap?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // A tag pressed in search or a folder's tags lands here (`homeTag.ts`).
  const [tag, setTag] = useHomeTag();
  const [now] = useState(() => Date.now());
  // Once per arrival on Home, not on every redraw.
  const shown = useRef(onShown);
  useEffect(() => {
    shown.current?.();
  }, []);
  const home = useMemo(() => {
    const built = buildHome({ ...source, pins, opened, recents, tag, now });
    // A tag gone from every note would narrow Home to nothing: show everything instead.
    return built.tagged?.count === 0 ? buildHome({ ...source, pins, opened, recents, tag: null, now }) : built;
  }, [source, pins, opened, recents, tag, now]);
  const activeTag = home.tagged?.tag ?? null;
  const hold = (path: string, kind: "note" | "folder") =>
    onTogglePin === null ? undefined : () => onTogglePin(path, kind);

  return (
    <View style={styles.page} testID="phone-home">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
            {title}
          </Text>
          <Text variant="meta" style={styles.sub} testID="phone-home-totals">
            {countLabel(home.totals.notes, home.totals.folders)}
          </Text>
        </View>
        {onNewFolder === undefined ? null : (
          <Pressable
            onPress={onNewFolder}
            accessibilityRole="button"
            accessibilityLabel="New folder"
            style={({ pressed }) => [styles.roundButton, pressed ? styles.pressed : null]}
            testID="phone-home-new-folder"
          >
            <Icon name="folderPlus" size={20} color={colors.text} />
          </Pressable>
        )}
        {onActions === undefined ? null : (
          <Pressable
            onPress={(event) => onActions({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
            accessibilityRole="button"
            accessibilityLabel="Workspace actions"
            style={({ pressed }) => [styles.roundButton, pressed ? styles.pressed : null]}
            testID="phone-home-actions"
          >
            <Icon name="more" size={20} color={colors.text} />
          </Pressable>
        )}
      </View>

      {home.tagged === null ? null : (
        <View style={styles.tagged} testID="phone-home-tagged">
          <Icon name="tag" size={18} color={colors.accentText} />
          <Text style={styles.taggedText} numberOfLines={1}>
            {`Tagged ${home.tagged.tag} · ${countLabel(home.tagged.count, 0)}`}
          </Text>
          <Pressable
            onPress={() => setTag(null)}
            accessibilityRole="button"
            accessibilityLabel="Show everything"
            style={({ pressed }) => [styles.taggedClear, pressed ? styles.pressed : null]}
            testID="phone-home-tagged-clear"
          >
            <Text style={styles.taggedClearText}>Show all</Text>
          </Pressable>
        </View>
      )}

      {onOpenMap === undefined ? null : <MapPlace onPress={onOpenMap} />}

      {home.pinned.length === 0 ? null : (
        <Section label="Pinned">
          <View style={styles.grid}>
            {home.pinned.map((tile) => (
              <Tile
                key={tile.path}
                icon={tile.kind === "folder" ? "folder" : "file"}
                title={tile.title}
                shared={tile.kind === "folder" && tile.shared}
                lines={[
                  tile.kind === "folder"
                    ? countLabel(tile.notes, tile.folders)
                    : tile.updatedAt === undefined
                      ? tile.place
                      : `Edited ${whenLabel(tile.updatedAt, now)}`,
                ]}
                onPress={() => onOpen(tile.path)}
                onLongPress={hold(tile.path, tile.kind)}
                style={styles.gridTile}
              />
            ))}
          </View>
        </Section>
      )}

      {home.openMost.length === 0 ? null : (
        <Section label="You open most">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
            {home.openMost.map((folder) => (
              <Tile
                key={folder.path}
                icon="folder"
                title={folder.title}
                shared={folder.shared}
                lines={[countLabel(folder.notes, 0), folder.label]}
                onPress={() => onOpen(folder.path)}
                onLongPress={hold(folder.path, "folder")}
                style={styles.railTile}
              />
            ))}
          </ScrollView>
        </Section>
      )}

      {home.recent.length === 0 ? null : (
        <Section label="Recent">
          <Card>
            {home.recent.map((note) => (
              <NoteRow
                key={note.path}
                note={note}
                when={whenOf(note.seenAt ?? note.updatedAt, now)}
                onPress={() => onOpen(note.path)}
                onLongPress={hold(note.path, "note")}
              />
            ))}
          </Card>
        </Section>
      )}

      <Section label="All folders">
        {home.folders.length === 0 ? (
          <Text variant="meta" style={styles.empty}>
            {activeTag === null ? "No folders yet." : `No folders hold a note tagged ${activeTag}.`}
          </Text>
        ) : (
          <Card>
            {home.folders.map((folder) => (
              <FolderLine
                key={folder.path}
                folder={folder}
                onPress={() => onOpen(folder.path)}
                onLongPress={hold(folder.path, "folder")}
              />
            ))}
          </Card>
        )}
      </Section>

      {home.notes.length === 0 ? null : (
        <Section label="Notes">
          <Card>
            {home.notes.map((note) => (
              <NoteRow
                key={note.path}
                note={note}
                when=""
                onPress={() => onOpen(note.path)}
                onLongPress={hold(note.path, "note")}
              />
            ))}
          </Card>
        </Section>
      )}

      {foot === undefined ? null : (
        <Text variant="treeMeta" style={styles.foot} testID="context-foot">
          {foot}
        </Text>
      )}
    </View>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text variant="eyebrow" style={styles.sectionLabel} accessibilityRole="header">
        {label}
      </Text>
      {children}
    </View>
  );
}

function Card({ children }: { children: ReactNode[] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card}>
      {children.map((child, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <View style={styles.rule} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

function Tile({
  icon,
  title,
  shared,
  lines,
  onPress,
  onLongPress,
  style,
}: {
  icon: IconName;
  title: string;
  shared: boolean;
  lines: string[];
  onPress: () => void;
  onLongPress?: () => void;
  style: object;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[title, ...lines].join(", ")}
      accessibilityHint={onLongPress === undefined ? undefined : "Hold to pin or unpin"}
      style={({ pressed }) => [styles.tile, style, pressed ? styles.pressed : null]}
    >
      <Icon name={icon} size={20} color={colors.text2} />
      <View style={styles.tileTitleRow}>
        <Text style={styles.tileTitle} numberOfLines={1}>
          {title}
        </Text>
        {shared ? <Icon name="people" size={14} color={colors.markTeam} /> : null}
      </View>
      {lines.map((line) => (
        <Text key={line} variant="meta" numberOfLines={1}>
          {line}
        </Text>
      ))}
    </Pressable>
  );
}

function NoteRow({
  note,
  when,
  onPress,
  onLongPress,
}: {
  note: HomeNoteTile;
  when: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const detail = [note.place, note.lede].filter((part): part is string => !!part).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[note.title, detail, when].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <Icon name="file" size={20} color={colors.text2} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {note.title}
          </Text>
          <Text variant="meta">{when}</Text>
        </View>
        {detail === "" ? null : (
          <Text variant="meta" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** The live map's row on Home: a place, like a folder, that opens the map. */
function MapPlace({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Card>
      {[
        <Pressable
          key="map"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="Map, who is working in this workspace, live"
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          testID="phone-home-map"
        >
          <Icon name="constellation" size={20} color={colors.text2} />
          <View style={styles.folderName}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              Map
            </Text>
          </View>
          <Text variant="meta" numberOfLines={1} style={styles.counts}>
            Who is working, live
          </Text>
          <Icon name="chevronRight" size={16} color={colors.muted} />
        </Pressable>,
      ]}
    </Card>
  );
}

function FolderLine({
  folder,
  onPress,
  onLongPress,
}: {
  folder: HomeFolder;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const counts = countLabel(folder.notes, folder.folders);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${folder.title}${folder.shared ? ", shared" : ""}, ${counts}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      testID="phone-home-folder"
    >
      <Icon name="folder" size={20} color={colors.text2} />
      <View style={styles.folderName}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {folder.title}
        </Text>
        {folder.shared ? <Icon name="people" size={14} color={colors.markTeam} /> : null}
      </View>
      <Text variant="meta" numberOfLines={1} style={styles.counts}>
        {counts}
      </Text>
      <Icon name="chevronRight" size={16} color={colors.muted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    page: { paddingHorizontal: layout.readingMargin, paddingBottom: space.x6, gap: space.x5 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, paddingTop: space.x2 },
    headText: { flex: 1, gap: space.x1 },
    title: {
      fontFamily: fonts.display,
      fontSize: touchType.title,
      lineHeight: leading(touchType.title, 1.15),
      fontWeight: "700",
      letterSpacing: tracking(touchType.title, -0.02),
      color: colors.text,
    },
    sub: { color: colors.muted },
    roundButton: {
      width: 44,
      height: 44,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.6 },
    tagged: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 44,
      paddingLeft: space.x4,
      borderRadius: radii.pill,
      backgroundColor: colors.accentDim,
    },
    taggedText: { flex: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.accentText },
    taggedClear: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.x4 },
    taggedClearText: { fontFamily: fonts.body, fontSize: touchType.ui, fontWeight: "600", color: colors.accentText },
    section: { gap: space.x2 },
    sectionLabel: { paddingHorizontal: space.x1 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tile: {
      backgroundColor: colors.pageSurface,
      borderRadius: radii.sheet,
      padding: space.x4,
      gap: space.x1,
      minHeight: 104,
    },
    gridTile: { flexBasis: "46%", flexGrow: 1 },
    rail: { gap: space.x3, paddingRight: space.x4 },
    railTile: { width: 148 },
    tileTitleRow: { flexDirection: "row", alignItems: "center", gap: space.x1 + 2, marginTop: space.x2 },
    tileTitle: {
      fontFamily: fonts.body,
      fontSize: touchType.ui,
      fontWeight: "600",
      color: colors.text,
      flexShrink: 1,
    },
    card: { backgroundColor: colors.pageSurface, borderRadius: radii.sheet, overflow: "hidden" },
    rule: { height: 1, marginLeft: space.x4 + 20 + space.x3, backgroundColor: colors.line },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 52,
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
    },
    rowPressed: { backgroundColor: colors.rowSelected },
    rowText: { flex: 1, gap: 2 },
    rowTop: { flexDirection: "row", alignItems: "baseline", gap: space.x2 },
    rowTitle: { flexShrink: 1, flexGrow: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
    folderName: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x1 + 2 },
    counts: { flexShrink: 0 },
    empty: { paddingHorizontal: space.x1 },
    foot: { color: colors.muted },
  });
