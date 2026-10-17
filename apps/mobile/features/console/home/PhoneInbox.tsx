import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { EmojiGlyph } from "../emoji/EmojiGlyph";
import { RowOpeningBar } from "../files/RowOpening";
import { fonts, layout, pointerType, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { buildHome, type HomeOpened } from "./homeModel";
import { Card, Section, type HoldPoint } from "./homeRows";
import { buildInbox, inboxCount, inboxWhen, type FiledNote, type InboxActivity, type LooseNote } from "./inboxModel";
import type { HomeSource } from "./useHomeSource";

/**
 * The phone's first page: Inbox (leadership weekly, 2026-10-17; boards 1 and 2
 * of `meeting-2026-10-17/phone-inbox/`, approved by Dev2: "THIS LOOKS AMAZING!
 * LETS DO IT").
 *
 * Top to bottom: the title and how much is loose, one row of small round
 * folder icons ending in All, the **Loose notes**, and **Filed today** — the
 * notes an agent (or you) moved out of the Inbox today, with where they went.
 * Search and the new-note key are the bottom bar's, as on every page.
 *
 * What goes where is `inboxModel.ts`'s; this only draws it.
 */
export function PhoneInbox({
  source,
  opened,
  entries,
  isMe,
  onOpen,
  onAll,
  onActions,
  onHold,
  iconOf,
  opening = null,
  onPreload,
}: {
  source: HomeSource;
  opened: readonly HomeOpened[];
  /** `activity.md`'s lines, for Filed today; empty before it has loaded. */
  entries: readonly InboxActivity[];
  isMe: (by: string) => boolean;
  onOpen: (path: string) => void;
  /** The last dot: opens Folders. */
  onAll: () => void;
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
    return buildInbox({ notes: source.notes, home, entries, isMe, now });
  }, [source, opened, entries, isMe, now]);
  const dots = inbox.dots.map((dot) => dot.path).join("\n");
  const preload = useRef(onPreload);
  preload.current = onPreload;
  useEffect(() => {
    if (dots !== "") preload.current?.(dots.split("\n"));
  }, [dots]);
  const hold = (path: string) =>
    onHold === undefined
      ? undefined
      : (event: GestureResponderEvent) => onHold(path, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });

  return (
    <View style={styles.page} testID="phone-home">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} accessibilityRole="header">
            Inbox
          </Text>
          <Text style={styles.sub} testID="phone-inbox-count">
            {inboxCount(inbox.loose.length, inbox.filed.length)}
          </Text>
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

      <View style={styles.dots} testID="phone-inbox-dots">
        {inbox.dots.map((folder) => {
          const emoji = iconOf?.(folder.path) ?? null;
          return (
            <Pressable
              key={folder.path}
              onPress={() => onOpen(folder.path)}
              onLongPress={hold(folder.path)}
              accessibilityRole="button"
              accessibilityLabel={folder.title}
              style={({ pressed }) => [styles.dot, pressed || opening === folder.path ? styles.pressed : null]}
              testID="phone-inbox-dot"
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
        <Pressable
          onPress={onAll}
          accessibilityRole="button"
          accessibilityLabel="All folders"
          style={({ pressed }) => [styles.dot, pressed ? styles.pressed : null]}
          testID="phone-inbox-all"
        >
          <View style={styles.dotCircle}>
            <Icon name="more" size={20} color={colors.text} />
          </View>
          <Text style={styles.dotName} numberOfLines={1}>
            All
          </Text>
        </Pressable>
      </View>

      {inbox.loose.length === 0 ? (
        <View style={styles.empty} testID="phone-inbox-empty">
          <Text style={styles.emptyTitle}>All filed.</Text>
          <Text style={styles.emptyText}>
            {inbox.filed.length === 0
              ? "New notes start here, and your agents file them."
              : "New notes start here. Your agents file them, and you can see where below."}
          </Text>
        </View>
      ) : (
        <Section label="Loose notes">
          <Card>
            {inbox.loose.map((note) => (
              <LooseRow
                key={note.path}
                note={note}
                when={note.updatedAt === undefined ? "" : inboxWhen(note.updatedAt, now)}
                onPress={() => onOpen(note.path)}
                onLongPress={hold(note.path)}
                opening={opening === note.path}
              />
            ))}
          </Card>
        </Section>
      )}

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
    </View>
  );
}

function LooseRow({
  note,
  when,
  onPress,
  onLongPress,
  opening,
}: {
  note: LooseNote;
  when: string;
  onPress: () => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  opening: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[note.title, when, note.lede ?? ""].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed || opening ? styles.rowPressed : null]}
      testID="phone-inbox-loose"
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {note.title}
      </Text>
      <Text style={styles.rowSub} numberOfLines={1}>
        {when === "" ? null : <Text style={styles.rowWhen}>{when}</Text>}
        {when === "" || !note.lede ? "" : "  "}
        {note.lede ?? ""}
      </Text>
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
    dots: { flexDirection: "row", justifyContent: "flex-start", gap: 7 },
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
    filedRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    filedText: { flex: 1, minWidth: 0, gap: 2 },
    filedWhere: { flexDirection: "row", alignItems: "center", gap: 4 },
    filedPlace: { flexShrink: 1 },
    empty: { gap: space.x2, paddingTop: space.x2 },
    emptyTitle: { fontFamily: fonts.body, fontSize: touchType.h3, fontWeight: "700", color: colors.text },
    emptyText: { fontFamily: fonts.body, fontSize: pointerType.lede, lineHeight: 21, color: colors.muted },
  });
