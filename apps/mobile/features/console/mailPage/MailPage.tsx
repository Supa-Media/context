/**
 * The Mail page (the owner's boards, approved 2026-11-25: "yeah mail page looks good"): every conversation the reader
 * can see, newest first, with a view each for bots, areas and other notes. Drawn where a note would be (`?mail=1`,
 * `BrowseDocument`), so the tree stays beside it, and opened from the Mail button under the map on the right rail.
 *
 * The files stay where they are: a conversation is a note's ```mail block, and this page only gathers them
 * (`model.ts`, from `/files/mail`). Open one and it reads like a thread, with a box that says it is mail, not a chat:
 * a bot answers when it answers, and what it thinks in between stays in its own app. On a phone the list is the page
 * and a conversation takes the whole screen.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { pointerType, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { agoLabel } from "../files/mail/model";
import { MAIL_VIEWS, groupsFor, sideName, type Conversation, type MailView } from "./model";
import type { MailRoute } from "./MailRouteContext";
import { MailThread, type MailNoteIO } from "./MailThread";
import { useConversations } from "./useConversations";
import { useMailIO } from "./useMailIO";
import type { MailNoteRow } from "./model";

export function MailPage({
  route,
  compact,
  onOpen,
  onClose,
  fixture,
}: {
  route: MailRoute;
  compact: boolean;
  onOpen: (path: string) => void;
  onClose: () => void;
  /** The e2e fixture's notes and their text, in place of the gateway (`features/e2e/MailPageFixture.tsx`). */
  fixture?: { load: () => Promise<{ notes: MailNoteRow[]; complete: boolean }>; io: MailNoteIO };
}) {
  const styles = useThemedStyles(makeStyles);
  const { state, conversations, refresh, markSeen } = useConversations(route, fixture?.load);
  const appIO = useMailIO(route.workspaceId);
  const io = fixture?.io ?? appIO;
  const [view, setView] = useState<MailView>("all");
  const [selected, setSelected] = useState<string | null>(null);
  // Asked again as the page opens, so it never shows a two-minute-old list.
  useEffect(() => refresh(), [refresh]);
  const groups = useMemo(() => groupsFor(view, conversations), [view, conversations]);
  const shown = groups.flatMap((group) => group.conversations);
  // A wide page reads the newest at once; a phone waits for a tap.
  const open = selected !== null ? conversations.find((each) => each.path === selected) : compact ? undefined : shown[0];
  useEffect(() => {
    if (open?.last) markSeen(open.path, open.last.at);
  }, [open?.path, open?.last, markSeen]);

  const thread =
    open === undefined ? null : (
      <MailThread
        key={open.path}
        conversation={open}
        io={io}
        {...(route.me === undefined ? {} : { me: route.me })}
        onOpenNote={onOpen}
        onSent={refresh}
        {...(compact ? { onBack: () => setSelected(null) } : {})}
      />
    );
  if (compact && thread !== null) return <View style={styles.page}>{thread}</View>;

  const list = (
    <View style={styles.list} testID="mail-list">
      {state.status === "loading" ? (
        <Text variant="treeMeta" style={styles.muted}>
          Gathering mail…
        </Text>
      ) : state.status === "unavailable" ? (
        <Text variant="treeMeta" style={styles.muted} testID="mail-unavailable">
          Mail can't be gathered for this workspace yet. Each area's and bot's mail is still on its own page.
        </Text>
      ) : shown.length === 0 ? (
        <Text variant="treeMeta" style={styles.muted} testID="mail-empty">
          {view === "all" ? "No mail yet." : view === "bots" ? "No mail with a bot yet." : view === "areas" ? "No area mail yet." : "No note has mail yet."}
        </Text>
      ) : null}
      {groups.map((group) => (
        <View key={group.key} style={styles.group}>
          {group.title !== "" ? (
            <Text variant="treeMeta" style={styles.groupTitle}>
              {group.title}
            </Text>
          ) : null}
          {group.conversations.map((each) => (
            <MailRow key={`${group.key}:${each.path}`} conversation={each} selected={open?.path === each.path} me={route.me} onPress={() => setSelected(each.path)} />
          ))}
        </View>
      ))}
      {state.status === "ready" && !state.complete ? (
        <Text variant="treeMeta" style={styles.muted}>
          Still gathering: more mail shows when you look again.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.page} testID="mail-page">
      <View style={styles.head}>
        <Text variant="paneTitle">Agent Mail</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close Agent Mail" style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.close, hovered && styles.closeHover]} testID="mail-close">
          <Text variant="treeMeta" style={styles.muted}>
            Close
          </Text>
        </Pressable>
      </View>
      <View style={styles.views} role="tablist">
        {MAIL_VIEWS.map((each) => (
          <Pressable
            key={each.id}
            role="tab"
            aria-selected={view === each.id}
            onPress={() => {
              setView(each.id);
              setSelected(null);
            }}
            style={[styles.view, view === each.id && styles.viewOn]}
            testID={`mail-view-${each.id}`}
          >
            <Text variant="treeMeta" style={view === each.id ? styles.viewWordOn : styles.muted}>
              {each.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {compact ? (
        <ScrollView>{list}</ScrollView>
      ) : (
        <View style={styles.split}>
          <ScrollView style={styles.listScroll}>{list}</ScrollView>
          <View style={styles.reading}>{thread ?? <Text variant="treeMeta" style={styles.muted}>Pick a conversation.</Text>}</View>
        </View>
      )}
    </View>
  );
}

function MailRow({ conversation, selected, me, onPress }: { conversation: Conversation; selected: boolean; me: string | undefined; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { last } = conversation;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${conversation.title}${conversation.fresh ? ", new" : ""}`}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, (hovered || selected) && styles.rowOn]}
      testID={`mail-row-${conversation.path}`}
    >
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text variant="tree" numberOfLines={1} style={[styles.name, styles.grow]}>
            {conversation.title}
          </Text>
          <Text variant="treeMeta" style={styles.muted}>
            {last === null ? "" : agoLabel(last.at)}
          </Text>
          {conversation.fresh ? <View style={[styles.newDot, { backgroundColor: colors.ok }]} testID={`mail-new-${conversation.path}`} /> : null}
        </View>
        <Text variant="treeMeta" numberOfLines={1} style={styles.muted}>
          {last === null ? conversation.where : `${sideName(last.from, me)}: ${last.text}`}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, gap: space.x2, paddingTop: space.x2 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.x4 },
    close: { paddingVertical: space.x1, paddingHorizontal: space.x2, borderRadius: radii.control },
    closeHover: { backgroundColor: colors.chrome },
    muted: { color: colors.muted },
    views: { flexDirection: "row", gap: space.x1, paddingHorizontal: space.x4 },
    view: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.line },
    viewOn: { backgroundColor: colors.text, borderColor: colors.text },
    viewWordOn: { color: colors.surface, fontWeight: "600" },
    split: { flex: 1, flexDirection: "row", minHeight: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    listScroll: { width: 360, flexGrow: 0, flexShrink: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
    list: { paddingHorizontal: space.x4, paddingVertical: space.x2, gap: 2 },
    reading: { flex: 1, minWidth: 0 },
    group: { gap: 2, marginBottom: space.x2 },
    groupTitle: { color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, fontSize: pointerType.meta, marginVertical: space.x1 },
    row: { paddingVertical: space.x2, paddingHorizontal: space.x2, marginHorizontal: -space.x2, borderRadius: radii.sm },
    rowOn: { backgroundColor: colors.rowSelected },
    rowText: { gap: 2, minWidth: 0 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flexGrow: 1, flexShrink: 1 },
    name: { fontWeight: "600" },
    newDot: { width: 8, height: 8, borderRadius: 4 },
  });
