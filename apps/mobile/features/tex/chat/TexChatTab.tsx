import { useEffect, useRef, useState } from "react";
import { Animated, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";
import {
  isPending,
  openAskRow,
  type AppChatRow,
  type AskChoice,
  type ChatLine,
  type ReactionEmoji,
} from "./appChatGateway";
import type { ApprovalsView } from "../../approvals/useApprovals";
import { useAppChat, type AppChatView } from "./useAppChat";
import { TexChatComposer, type EditTarget, type ReplyTarget } from "./TexChatComposer";
import { TexChatRow } from "./TexChatRow";
import type { PickedFile } from "./appChatFiles";
import { TexChatHeader } from "./TexChatHeader";
import { chatTimeline } from "./approvalTimeline";
import { TexApprovalCard } from "./TexApprovalCard";

/** How long a row stays lit after the log jumps to it. */
const FLASH_MS = 1500;
/** The line in the middle of an empty chat. */
export const TEX_EMPTY = "Say hi to Tex, or send it something to do.";
/** The line when this console cannot reach Tex at all. */
export const TEX_UNAVAILABLE = "Tex is not reachable from this console.";
/** Typing shows as Tex's own line while a turn is open. */
export const TEX_WORKING = "Tex is working on it";

/** Rows from the same person within this long share one time under them. */
const GROUP_MS = 5 * 60_000;
/** How close to the foot of the log the reader must be for new rows to pull it down. */
const STICK_PX = 48;

/**
 * The console's right-panel tab for the chat with Tex: the person's own chat
 * with Tex, the same history as their texts.
 *
 * Mounted only while the tab is showing, so the hook polls only then; leaving
 * the tab stops it. What it draws is decided by `AppChatView`, the hook's
 * return value, which the other half of the tab (`TexChatView`) takes as a
 * prop so it can be drawn with a fake.
 */
export function TexChatTab({
  workspaceId,
  endpoint,
  approvals,
  onOpenNote,
}: {
  workspaceId: string;
  endpoint: string;
  /** The held calls waiting on the person, drawn as cards in the log. */
  approvals?: ApprovalsView;
  /** Opens a note a row links to, by its href and path; `null` where the console cannot open one. */
  onOpenNote?: ((href: string, path: string) => void) | null;
}) {
  const view = useAppChat({ workspaceId, endpoint, enabled: true });
  /*
    Opening the tab asks for the approvals again, as pressing the old Approvals
    tab did: the count on the tab is up to a minute old, and the cards a person
    opened the chat to answer should be the ones waiting now.
  */
  const refreshApprovals = useRef(approvals?.refresh);
  refreshApprovals.current = approvals?.refresh;
  useEffect(() => {
    refreshApprovals.current?.();
  }, []);
  return <TexChatView view={view} approvals={approvals} onOpenNote={onOpenNote} />;
}

/** The tab's face: a header with Tex, the log, the typing mark, the approval, the box. */
export function TexChatView({
  view,
  approvals,
  onOpenNote,
}: {
  view: AppChatView;
  approvals?: ApprovalsView;
  onOpenNote?: ((href: string, path: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const log = useRef<ScrollView>(null);
  const stuck = useRef(true);
  const ys = useRef(new Map<string, number>());

  const lines = view.lines;
  const timeline = chatTimeline(lines, approvals);
  // The approval Tex is waiting on, if any: its buttons show under that row only.
  const askId = openAskRow(lines)?.id ?? null;
  // Rows from one person share a time under the last of them, read off the lines alone.
  const timeLabels = new Map<ChatLine, string | null>();
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    timeLabels.set(
      line,
      next === undefined || next.who !== line.who || next.at - line.at > GROUP_MS ? timeText(line.at) : null,
    );
  });

  // Esc closes the picture overlay.
  useEffect(() => {
    if (opened === null || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpened(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [opened]);

  // The row a jump landed on is lit for a moment, then goes back to plain.
  useEffect(() => {
    if (flashId === null) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  const jump = (rowId: string) => {
    const y = ys.current.get(rowId);
    if (y === undefined) return;
    stuck.current = false;
    log.current?.scrollTo({ y: Math.max(0, y - space.x2), animated: true });
    setFlashId(rowId);
  };

  const send = (text: string, pictures: Blob[], files: PickedFile[]) => {
    stuck.current = true;
    if (edit !== null) {
      view.edit(edit.id, text);
      setEdit(null);
      return;
    }
    // Files ride along only when there are some, so a words-and-pictures send looks as it always did.
    view.send(text, { pictures, ...(files.length > 0 ? { files } : {}), replyTo: reply?.id ?? null });
    setReply(null);
  };

  const react = (rowId: string, emoji: ReactionEmoji) => view.react(rowId, emoji);

  return (
    <View style={styles.root} testID="tex-chat">
      <TexChatHeader busy={view.busy} />

      <ScrollView
        ref={log}
        style={styles.log}
        contentContainerStyle={styles.logBody}
        onScroll={(event) => {
          const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
          stuck.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < STICK_PX;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (stuck.current) log.current?.scrollToEnd({ animated: true });
        }}
        testID="tex-log"
      >
        {timeline.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="foot" style={styles.muted} testID="tex-empty">
              {view.available ? (view.phase === "idle" ? "" : TEX_EMPTY) : TEX_UNAVAILABLE}
            </Text>
          </View>
        ) : null}

        {timeline.map((entry) => {
          if (entry.kind === "approval") {
            return (
              <TexApprovalCard
                key={`approval:${entry.approval.id}`}
                approval={entry.approval}
                state={entry.state}
                note={entry.note}
                now={Date.now()}
                onDecide={(id, action) => approvals?.decide(id, action)}
              />
            );
          }
          const line = entry.line;
          const key = isPending(line) ? line.localId : line.id;
          const timeLabel = timeLabels.get(line) ?? null;
          return (
            <View
              key={key}
              onLayout={(event) => {
                if (!isPending(line)) ys.current.set(line.id, event.nativeEvent.layout.y);
              }}
            >
              <TexChatRow
                line={line}
                askOpen={!isPending(line) && line.id === askId}
                answer={isPending(line) ? undefined : view.answers[line.id]}
                pictureUrl={view.pictureUrl}
                timeLabel={timeLabel}
                onOpenPicture={setOpened}
                onDownloadFile={view.downloadFile}
                onAnswer={(rowId: string, choice: AskChoice) => view.answer(rowId, choice)}
                onReact={react}
                onReply={(row: AppChatRow) => {
                  setEdit(null);
                  setReply({ id: row.id, who: row.who, text: row.text });
                }}
                onEdit={(row: AppChatRow) => {
                  setReply(null);
                  setEdit({ id: row.id, text: row.text });
                }}
                onUnsend={(rowId: string) => view.unsend(rowId)}
                onRetry={(localId: string) => view.retry(localId)}
                onJump={jump}
                onOpenNote={onOpenNote ?? null}
                flash={!isPending(line) && line.id === flashId}
              />
            </View>
          );
        })}

        {/*
          A refused or unanswered decision leaves its card waiting and says why here. A settled
          card already carries its own note, so that note is not said twice.
        */}
        {approvals?.notice?.tone === "warn" &&
        !approvals.decided.some((d) => d.note === approvals.notice?.text) ? (
          <Text variant="foot" style={styles.error} testID="tex-approvals-notice">
            {approvals.notice.text}
          </Text>
        ) : null}

        {approvals?.phase === "failed" && approvals.error !== null ? (
          <Text variant="foot" style={styles.muted} testID="tex-approvals-error">
            {approvals.error}
          </Text>
        ) : null}

        {view.busy ? <Working styles={styles} colors={colors} /> : null}
      </ScrollView>

      {view.error !== null ? (
        <Text variant="foot" style={styles.error} testID="tex-error">
          {view.error}
        </Text>
      ) : null}

      <TexChatComposer
        sending={view.sending}
        disabled={!view.available}
        reply={reply}
        edit={edit}
        onCancelReply={() => setReply(null)}
        onCancelEdit={() => setEdit(null)}
        onSend={send}
        onTyping={view.typing}
      />

      {opened !== null ? (
        <Pressable
          onPress={() => setOpened(null)}
          accessibilityRole="button"
          accessibilityLabel="Close picture"
          style={styles.overlay}
          testID="tex-overlay"
        >
          <Image source={{ uri: opened }} style={styles.full} resizeMode="contain" accessibilityLabel="Picture, full size" />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Tex's typing mark: three dots in a Tex-side bubble, and what it is doing. */
function Working({ styles, colors }: { styles: Styles; colors: Colors }) {
  const reduce = useReducedMotion();
  const a = useRef(new Animated.Value(0.3)).current;
  const b = useRef(new Animated.Value(0.3)).current;
  const c = useRef(new Animated.Value(0.3)).current;
  const dots = [a, b, c];

  useEffect(() => {
    if (reduce) return;
    const loops = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 150),
          Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: false }),
          Animated.timing(value, { toValue: 0.3, duration: 300, useNativeDriver: false }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
    // The three values are created once and never change identity.
  }, [reduce]);

  return (
    <View style={styles.working} testID="tex-typing">
      <View style={styles.typingBubble} accessibilityLabel="Tex is typing">
        {dots.map((value, index) => (
          <Animated.View key={index} style={[styles.dot, { backgroundColor: colors.muted, opacity: reduce ? 0.6 : value }]} />
        ))}
      </View>
      <Text variant="foot" style={styles.muted}>
        {TEX_WORKING}
      </Text>
    </View>
  );
}

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0, position: "relative" },
    muted: { color: colors.muted },
    log: { flex: 1, minHeight: 0 },
    logBody: {
      flexGrow: 1,
      paddingTop: 40,
      paddingHorizontal: 14,
      paddingBottom: 8,
      gap: 6,
      justifyContent: "flex-end",
    },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 120 },
    working: { alignSelf: "flex-start", gap: space.x1 },
    typingBubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderRadius: 14,
      borderBottomLeftRadius: 4,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    dot: { width: 6, height: 6, borderRadius: radii.pill },
    error: { color: colors.critText, paddingHorizontal: space.x4 },
    overlay: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 10,
      alignItems: "center",
      justifyContent: "center",
      padding: space.x4,
      backgroundColor: colors.scrim,
    },
    full: { width: "100%", height: "100%" },
  });
