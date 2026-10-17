import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, leading, pointerType, radii, space, touchType, tracking } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
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
import { AddFolderLine, Card, FolderLine, NoteRow, PinnedNote, Section, type HoldPoint } from "./homeRows";
import { ChaosHomeLine } from "../../chaos/ChaosHomeLine";
import { TrashHomeLine } from "../trash/TrashEntry";

const whenOf = (at: number | undefined, now: number) => (at === undefined ? "" : whenLabel(at, now));

/**
 * The phone's Folders page: what Home was, opened from Inbox's All.
 *
 * Approved by the owner on 2026-09-30 (the mobile Home artboards, board 01),
 * and slimmed on 2026-10-17 when the phone started opening in Inbox
 * (`PhoneInbox.tsx`; board 2 of `meeting-2026-10-17/phone-inbox/`). Top to
 * bottom: "Folders" and the workspace's size with a New folder button,
 * **Pinned** as rows, **All folders** with what each holds, then the
 * **Notes** outside every folder. You open most became the order of Inbox's
 * folder dots, and Recent left with it — Inbox's Filed today is where a note
 * you just wrote is found again. Notes outside every folder: Folders is the only page
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
  onHold,
  iconOf,
  onAddFolder,
  foot,
  opening = null,
  onPreload,
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
  /**
   * Held on a tile or row: that row's own menu, Pin or Unpin among its verbs.
   * Absent for a visitor. Never a pin by itself: a hold that pinned silently
   * is how notes nobody chose ended up under Pinned (owner, 2026-10-15).
   */
  onHold?: (path: string, at: HoldPoint) => void;
  /** A folder's own emoji, from "Set icon…"; absent draws every folder with the plain icon. */
  iconOf?: (path: string) => string | null;
  /** "Add a folder", the last line of All folders. Absent for who may not make one. */
  onAddFolder?: () => void;
  /** The workspace's storage line, as the root listing had it. */
  foot?: string;
  /** The page being read while Home stays on screen: its row says so. */
  opening?: string | null;
  /** The folders Home names, so their pages are read ahead of a press (`pageCache.preloadFronts`). */
  onPreload?: (folders: readonly string[]) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // The homepage's visitor has no Inbox: their page is still the workspace's own.
  const visitor = recents === null;
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
  // Every folder Home names, read ahead so the one pressed arrives whole.
  const named = useMemo(
    () =>
      [
        ...home.pinned.filter((tile) => tile.kind === "folder").map((tile) => tile.path),
        ...home.folders.map((folder) => folder.path),
      ].join("\n"),
    [home],
  );
  const preload = useRef(onPreload);
  preload.current = onPreload;
  useEffect(() => {
    if (named !== "") preload.current?.(named.split("\n"));
  }, [named]);
  const hold = (path: string) => (onHold === undefined ? undefined : (at: HoldPoint) => onHold(path, at));

  return (
    <View style={styles.page} testID="phone-home">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
            {visitor ? title : "Folders"}
          </Text>
          <Text style={styles.sub} testID="phone-home-totals">
            {visitor
              ? countLabel(home.totals.notes, home.totals.folders)
              : `${title} · ${home.totals.notes} note${home.totals.notes === 1 ? "" : "s"}`}
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

      {home.pinned.length === 0 ? null : (
        <Section label="Pinned">
          <Card>
            {home.pinned.map((tile) =>
              tile.kind === "folder" ? (
                <FolderLine
                  key={tile.path}
                  folder={tile}
                  icon={iconOf?.(tile.path) ?? null}
                  onPress={() => onOpen(tile.path)}
                  onLongPress={hold(tile.path)}
                  opening={opening === tile.path}
                />
              ) : (
                <PinnedNote
                  key={tile.path}
                  title={tile.title}
                  when={whenOf(tile.updatedAt, now)}
                  place={tile.place}
                  onPress={() => onOpen(tile.path)}
                  onLongPress={hold(tile.path)}
                  opening={opening === tile.path}
                />
              ),
            )}
          </Card>
        </Section>
      )}

      <Section label="All folders">
        {/* Under a tag, the list is a filter, so making a folder is not offered there. */}
        {(onAddFolder === undefined || activeTag !== null) && home.folders.length === 0 ? (
          <Text variant="meta" style={styles.empty}>
            {activeTag === null ? "No folders yet." : `No folders hold a note tagged ${activeTag}.`}
          </Text>
        ) : (
          <Card>
            {home.folders.map((folder) => (
              <FolderLine
                key={folder.path}
                folder={folder}
                icon={iconOf?.(folder.path) ?? null}
                onPress={() => onOpen(folder.path)}
                onLongPress={hold(folder.path)}
                opening={opening === folder.path}
              />
            ))}
            {onAddFolder === undefined || activeTag !== null ? null : <AddFolderLine onPress={onAddFolder} />}
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
                onLongPress={hold(note.path)}
                opening={opening === note.path}
              />
            ))}
          </Card>
        </Section>
      )}

      {/* The trash, a row of its own (board A4); nothing outside the console layout. */}
      {activeTag === null ? <TrashHomeLine /> : null}

      {/* How organized the workspace is, quietly, last (`features/chaos`); nothing until it is scored. */}
      <ChaosHomeLine />

      {foot === undefined ? null : (
        <Text variant="treeMeta" style={styles.foot} testID="context-foot">
          {foot}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingHorizontal: layout.readingMargin, paddingBottom: space.x6, gap: space.x5 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, paddingTop: space.x2 },
    headText: { flex: 1, gap: space.x1 },
    // 34pt, as Inbox's title: the two top pages are one pair (board 2).
    title: {
      fontFamily: fonts.display,
      fontSize: touchType.page,
      lineHeight: leading(touchType.page, 1.12),
      fontWeight: "700",
      letterSpacing: tracking(34, -0.02),
      color: colors.text,
    },
    sub: { fontFamily: fonts.body, fontSize: pointerType.lede, color: colors.muted },
    roundButton: {
      width: 44,
      height: 44,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardSurface,
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
    empty: { paddingHorizontal: space.x1 },
    foot: { color: colors.muted },
  });
