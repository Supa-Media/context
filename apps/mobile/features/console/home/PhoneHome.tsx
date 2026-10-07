import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, leading, radii, space, touchType, tracking } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import {
  buildHome,
  countLabel,
  whenLabel,
  type HomeOpened,
  type HomePin,
  type HomeRecent,
} from "./homeModel";
import type { HomeSource } from "./useHomeSource";
import { useHomeTag } from "./homeTag";
import { Card, FolderLine, MapPlace, NoteRow, Section, Tile } from "./homeRows";

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
    grid: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    gridTile: { flexBasis: "46%", flexGrow: 1 },
    rail: { gap: space.x3, paddingRight: space.x4 },
    railTile: { width: 148 },
    empty: { paddingHorizontal: space.x1 },
    foot: { color: colors.muted },
  });
