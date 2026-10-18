import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { EmojiGlyph } from "../emoji/EmojiGlyph";
import { RowOpeningBar } from "../files/RowOpening";
import { fonts, layout, pointerType, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { buildHome, type HomeOpened } from "./homeModel";
import { Card, Section, type HoldPoint } from "./homeRows";
import type { HomePin, HomeRecent } from "./homeModel";
import { HOME_LABEL } from "./phoneBack";
import {
  buildInbox,
  inboxWhen,
  type FiledNote,
  type InboxActivity,
  type InboxGroup,
  type InboxNote,
} from "./inboxModel";
import type { FolderListSource } from "../files/listBlock/model";
import { useNoteLedes } from "./noteLedes";
import type { HomeSource } from "./useHomeSource";

/**
 * The phone's first page: Inbox (leadership weekly, 2026-10-17; boards 1 and 2
 * of `meeting-2026-10-17/phone-inbox/`, approved by Dev2: "THIS LOOKS AMAZING!
 * LETS DO IT").
 *
 * Top to bottom: the title and how much is downloaded, every top-level folder
 * in one row that scrolls sideways (the Inbox first, as the folder it is),
 * **Pinned**, then the notes you edited by hand, from any folder, under Apple Notes' date headings (Dev2,
 * 2026-10-18: "we need a pinned and prev 30 days section like apple notes"),
 * and **Filed today** — the notes an
 * agent (or you) moved out of the Inbox today, with where they went — after
 * the last thirty days and before the months.
 * Search and the new-note key are the bottom bar's, as on every page.
 *
 * What goes where is `inboxModel.ts`'s; this only draws it.
 */
export function PhoneInbox({
  source,
  pins = [],
  recents = [],
  downloaded = null,
  downloading = false,
  onDownloads,
  ledeSource,
  opened,
  entries,
  isMe,
  onOpen,
  ready = true,
  onActions,
  onHold,
  iconOf,
  opening = null,
  onPreload,
}: {
  source: HomeSource;
  /** This person's pins: the notes among them are Pinned. */
  pins?: readonly HomePin[];
  /** This person's Recent: the notes they edited themselves are among them. */
  recents?: readonly HomeRecent[];
  /** "1,204 notes downloaded" (`downloadedLine`); `null` where nothing is kept on the device. */
  downloaded?: string | null;
  /** Notes are coming down now: a spinner beside that line, as Apple Notes has beside its count. */
  downloading?: boolean;
  /** The Downloads sheet, opened from that line. */
  onDownloads?: () => void;
  /** Where the first line of a note this device does not keep is read from (`noteLedes.ts`). */
  ledeSource?: FolderListSource;
  opened: readonly HomeOpened[];
  /** `activity.md`'s lines, for who wrote what and Filed today; empty before it has loaded. */
  entries: readonly InboxActivity[];
  isMe: (by: string) => boolean;
  onOpen: (path: string) => void;
  /**
   * Whether what the page is built from has arrived: until then it draws its
   * header and grey rows, never "nothing written" that turns into notes.
   */
  ready?: boolean;
  onActions?: (anchor: { x: number; y: number }) => void;
  onHold?: (path: string, at: HoldPoint) => void;
  iconOf?: (path: string) => string | null;
  opening?: string | null;
  onPreload?: (folders: readonly string[]) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [now] = useState(() => Date.now());
  const inbox = useMemo(() => {
    const home = buildHome({ ...source, pins: [], opened, recents: null, tag: null, now });
    return buildInbox({ notes: source.notes, pins, recents, home, entries, isMe, now });
  }, [source, pins, recents, opened, entries, isMe, now]);
  const shown = useMemo(() => [...inbox.pinned, ...inbox.groups.flatMap((entry) => entry.notes)], [inbox]);
  const lineOf = useNoteLedes(ledeSource, shown);
  // The folders on screen first: a phone shows about five before it scrolls.
  const ahead = inbox.folders
    .slice(0, PRELOAD_FOLDERS)
    .map((folder) => folder.path)
    .join("\n");
  const preload = useRef(onPreload);
  preload.current = onPreload;
  useEffect(() => {
    if (ahead !== "") preload.current?.(ahead.split("\n"));
  }, [ahead]);
  const hold = (path: string) =>
    onHold === undefined
      ? undefined
      : (event: GestureResponderEvent) => onHold(path, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });

  // Filed today sits between the last thirty days and the months before them.
  const isRecent = (label: string) => RECENT_GROUPS.has(label);
  const recent = inbox.groups.filter((entry) => isRecent(entry.label));
  const older = inbox.groups.filter((entry) => !isRecent(entry.label));
  const group = (entry: InboxGroup) => (
    <Section key={entry.label} label={entry.label}>
      <Card>
        {entry.notes.map((note) => (
          <NoteRow
            key={note.path}
            note={note}
            lede={lineOf(note)}
            when={note.at === undefined ? "" : inboxWhen(note.at, now)}
            onPress={() => onOpen(note.path)}
            onLongPress={hold(note.path)}
            opening={opening === note.path}
          />
        ))}
      </Card>
    </Section>
  );

  return (
    <View style={styles.page} testID="phone-home">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} accessibilityRole="header">
            {HOME_LABEL}
          </Text>
          {downloaded === null ? null : (
            <Pressable
              onPress={onDownloads}
              disabled={onDownloads === undefined}
              accessibilityRole="button"
              accessibilityLabel={`${downloaded}. Show downloads`}
              style={({ pressed }) => (pressed ? styles.pressed : null)}
              testID="phone-notes-downloaded"
            >
              <View style={styles.downloaded}>
                {downloading ? (
                  <ActivityIndicator size="small" color={colors.muted} testID="phone-notes-downloading" />
                ) : null}
                <Text style={styles.sub}>{downloaded}</Text>
              </View>
            </Pressable>
          )}
        </View>
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

      {/* Every top-level folder, the Inbox first, in one row that scrolls sideways (Dev2, 2026-10-18). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.folderRow}
        contentContainerStyle={styles.folders}
        testID="phone-inbox-folders"
      >
        {inbox.folders.map((folder) => {
          const emoji = iconOf?.(folder.path) ?? null;
          return (
            <Pressable
              key={folder.path}
              onPress={() => onOpen(folder.path)}
              onLongPress={hold(folder.path)}
              accessibilityRole="button"
              accessibilityLabel={folder.title}
              style={({ pressed }) => [styles.dot, pressed || opening === folder.path ? styles.pressed : null]}
              testID="phone-inbox-folder"
            >
              <View style={styles.dotCircle}>
                {emoji === null ? (
                  <Icon name="folder" size={20} color={colors.text2} />
                ) : (
                  <EmojiGlyph
                    emoji={emoji}
                    size={21}
                    textStyle={styles.dotEmoji}
                    fallback={<Icon name="folder" size={20} color={colors.text2} />}
                  />
                )}
              </View>
              <Text style={styles.dotName} numberOfLines={1}>
                {folder.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {inbox.pinned.length === 0 ? null : (
        <Section label="Pinned">
          <Card>
            {inbox.pinned.map((note) => (
              <NoteRow
                key={note.path}
                note={note}
                lede={lineOf(note)}
                when={note.at === undefined ? "" : inboxWhen(note.at, now)}
                onPress={() => onOpen(note.path)}
                onLongPress={hold(note.path)}
                opening={opening === note.path}
              />
            ))}
          </Card>
        </Section>
      )}

      {inbox.groups.length > 0 ? null : !ready ? (
        <View style={styles.loading} testID="phone-inbox-loading">
          {[0, 1, 2].map((at) => (
            <View key={at} style={styles.loadingCard} />
          ))}
        </View>
      ) : (
        <View style={styles.empty} testID="phone-inbox-empty">
          <Text style={styles.emptyTitle}>Nothing you{"\u2019"}ve handwritten yet.</Text>
        </View>
      )}
      {recent.map(group)}

      {inbox.filed.length === 0 ? null : (
        <Section label="Filed today">
          <Card>
            {inbox.filed.map((note) => (
              <FiledRow
                key={note.path}
                note={note}
                when={inboxWhen(note.at, now)}
                onPress={() => onOpen(note.path)}
                onLongPress={hold(note.path)}
                opening={opening === note.path}
              />
            ))}
          </Card>
        </Section>
      )}

      {older.map(group)}
    </View>
  );
}

/** Folders whose pages are read ahead: those on screen before the row scrolls. */
const PRELOAD_FOLDERS = 6;

const RECENT_GROUPS = new Set(["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days"]);

function NoteRow({
  note,
  lede,
  when,
  onPress,
  onLongPress,
  opening,
}: {
  note: InboxNote;
  /** Its first line; `undefined` while it is being read. */
  lede: string | null | undefined;
  when: string;
  onPress: () => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  opening: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // Rows come from any folder, so each says where, as Apple Notes' rows do.
  const folder = note.folder || "Top level";
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[note.title, when, lede ?? ""].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed || opening ? styles.rowPressed : null]}
      testID="phone-inbox-note"
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {note.title}
      </Text>
      {lede === undefined ? (
        // Still being read: the date, then a quiet bar where the line will be.
        <View style={styles.rowLoading}>
          {when === "" ? null : <Text style={[styles.rowSub, styles.rowWhen]}>{when}</Text>}
          <View style={styles.ledeLoading} testID="phone-inbox-lede-loading" />
        </View>
      ) : (
        <Text style={styles.rowSub} numberOfLines={1}>
          {when === "" ? null : <Text style={styles.rowWhen}>{when}</Text>}
          {when === "" || !lede ? "" : "  "}
          {lede ?? ""}
        </Text>
      )}
      <View style={styles.rowFolder}>
        <Icon name="folder" size={13} color={colors.muted} />
        <Text style={[styles.rowSub, styles.filedPlace]} numberOfLines={1}>
          {folder}
        </Text>
      </View>
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

function FiledRow({
  note,
  when,
  onPress,
  onLongPress,
  opening,
}: {
  note: FiledNote;
  when: string;
  onPress: () => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  opening: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const where = `${note.place} · by ${note.who}, ${when}`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${note.title}, filed in ${where}`}
      style={({ pressed }) => [styles.row, styles.filedRow, pressed || opening ? styles.rowPressed : null]}
      testID="phone-inbox-filed"
    >
      <View style={styles.filedText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {note.title}
        </Text>
        <View style={styles.filedWhere}>
          <Icon name="arrowRight" size={13} color={colors.muted} />
          <Text style={[styles.rowSub, styles.filedPlace]} numberOfLines={1}>
            {where}
          </Text>
        </View>
      </View>
      <Icon name="chevronRight" size={16} color={colors.muted} />
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingHorizontal: layout.readingMargin, paddingBottom: space.x6, gap: space.x5 },
    head: { flexDirection: "row", alignItems: "flex-end", gap: space.x3, paddingTop: space.x2 },
    headText: { flex: 1, gap: space.x1 },
    title: {
      fontFamily: fonts.display,
      fontSize: touchType.page,
      lineHeight: 40,
      fontWeight: "700",
      letterSpacing: -0.7,
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
    // The row runs to the screen's edges, so a folder half off the side says it scrolls.
    folderRow: { marginHorizontal: -layout.readingMargin, flexGrow: 0 },
    folders: { flexDirection: "row", gap: 7, paddingHorizontal: layout.readingMargin },
    dot: { width: 52, alignItems: "center", gap: 6 },
    dotCircle: {
      width: 46,
      height: 46,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardSurface,
    },
    dotEmoji: { fontSize: touchType.h3, lineHeight: 26, textAlign: "center" },
    dotName: { fontFamily: fonts.body, fontSize: touchType.meta, color: colors.muted, maxWidth: 58, textAlign: "center" },
    row: { paddingHorizontal: space.x4, paddingVertical: space.x3, gap: 2, minHeight: 60, justifyContent: "center" },
    rowPressed: { backgroundColor: colors.rowSelected },
    rowTitle: { fontFamily: fonts.body, fontSize: touchType.body, fontWeight: "600", color: colors.text },
    rowSub: { fontFamily: fonts.body, fontSize: pointerType.lede, color: colors.muted },
    rowWhen: { fontWeight: "600", color: colors.text },
    rowLoading: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 20 },
    ledeLoading: { flex: 1, maxWidth: 180, height: 10, borderRadius: radii.pill, backgroundColor: colors.rowSelected },
    downloaded: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowFolder: { flexDirection: "row", alignItems: "center", gap: 4 },
    filedRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    filedText: { flex: 1, minWidth: 0, gap: 2 },
    filedWhere: { flexDirection: "row", alignItems: "center", gap: 4 },
    filedPlace: { flexShrink: 1 },
    empty: { gap: space.x2, paddingTop: space.x2 },
    emptyTitle: { fontFamily: fonts.body, fontSize: touchType.h3, fontWeight: "700", color: colors.text },
    loading: { gap: space.x3 },
    loadingCard: { height: 92, borderRadius: radii.sheet, backgroundColor: colors.cardSurface },
  });
