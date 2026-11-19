import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useFrame } from "../app/AppFrame";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import { AsideStrip } from "../console/aside/AsideStrip";
import type { AsideTab } from "../console/aside/tabs";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { layout, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import type { AppChatRow, AskChoice, ChatLine, ReactionEmoji } from "../tex/chat/appChatGateway";
import type { AppChatView } from "../tex/chat/appChatView";
import { TexChatView } from "../tex/chat/TexChatTab";

/**
 * `/e2e-fixture?screen=tex-chat`: the console frame on the same demo data as
 * `app-frame-visual`, with the right panel open on the Tex tab.
 *
 * The tab's body is `TexChatView` fed by `useFakeTexChat`, a local `useState`
 * chat with no network. `AsidePanel` cannot be used here: its Tex tab mounts
 * `useAppChat`, which polls the gateway. So this file draws the tab strip and
 * hands the body to the same view the product uses.
 *
 * `fold=1` draws the panel folded to its rail (`AsideStrip`, the product's own),
 * so the Tex figure under the calendar is on the board.
 *
 * Everything in the chat is invented: no account, no route, no picture of a
 * real person. Pictures are a tiny PNG generated for this file.
 */

/** A 48x36 PNG (a sun over a hill), so a picture row has something to show. */
const PICTURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAIAAABAJy5dAAABD0lEQVR4nO3Oy0rDQBjF8fNgWfeZRKSUUIpIKaWIiEgpIiK913u9tPWy8EnOQ7jqIhDKJPNNTPLRWQR+yznf/HEwpFdwOKJXcDSmV1Cf0CtoTOkVhDPq+fsNkuQJmnMqSa2JCCu0FtQg1ERsQxzfUYMzyDbEyT01OINsQ7QfqMEZZBui80gNziDbEN0nanAG2YboPVODM8g2xOkLlQg1wgpnS+pJrZEnOH+lV3DxRq/g8p1eQf+DJQrCmuG/FzBYsbhkhyH7KVytWZCzJpblGq43zC17Ssx5E0FYu/lkDjlqYsJZxI9uv5hRkZRdqcdhPBp+U1BWivCdGRQZ/9BQeortx/SgPaqCqqAqqAraty2eudxxuk8XpAAAAABJRU5ErkJggg==";
const PICTURE_ID = "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const TABS: AsideTab[] = ["meetings", "tex"];

/** The seeded chat, oldest first. Every value is invented. */
function seedRows(now: number): AppChatRow[] {
  const minutesAgo = (m: number) => now - m * 60_000;
  return [
    { id: "r1", who: "tex", kind: "text", text: "Hi! I'm Tex. Ask me anything, or tell me what to do.", at: minutesAgo(20) },
    {
      id: "r2",
      who: "me",
      kind: "text",
      text: "add chicken salad stuff to my grocery list",
      at: minutesAgo(18),
      editable: true,
      reactions: [{ who: "tex", emoji: "❤️" }],
    },
    {
      id: "r3",
      who: "tex",
      kind: "text",
      text: "Added a Chicken salad section to Grocery List.",
      at: minutesAgo(17),
      reactions: [{ who: "me", emoji: "👍" }],
    },
    {
      id: "r4",
      who: "me",
      kind: "picture",
      text: "this one?",
      at: minutesAgo(12),
      pics: [PICTURE_ID],
      editable: true,
    },
    {
      id: "r5",
      who: "me",
      kind: "text",
      text: "pick up milk, eggs and oat milk",
      at: minutesAgo(10),
      edited: true,
      editable: true,
    },
    { id: "r6", who: "me", kind: "text", text: "", at: minutesAgo(9), unsent: true },
    {
      id: "r7",
      who: "me",
      kind: "text",
      text: "yes, and the chicken salad too",
      at: minutesAgo(6),
      replyTo: { id: "r3", text: "Added a Chicken salad section to Grocery List." },
      editable: true,
    },
    {
      id: "r8",
      who: "tex",
      kind: "text",
      text: "Here's the email to Sam: Hi Sam, the chicken salad order is set for Friday. Give it a 👍 and I'll send it.",
      at: minutesAgo(2),
      ask: { id: "a1", open: true },
    },
  ];
}

/**
 * A local `AppChatView`: sends, reactions, edits, unsends and answers change the
 * rows in `useState`, and nothing leaves the page.
 *
 * Timers are cleared on unmount, so leaving the screen cannot write into a view
 * that is gone.
 */
function useFakeTexChat(): AppChatView {
  const [lines, setLines] = useState<ChatLine[]>(() => seedRows(Date.now()));
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, AskChoice>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextId = useRef(0);
  const sentPictures = useRef(new Map<string, string>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const freshId = () => {
    nextId.current += 1;
    return `local-${nextId.current}`;
  };
  const texText = (text: string): AppChatRow => ({ id: freshId(), who: "tex", kind: "text", text, at: Date.now() });

  const updateRow = (rowId: string, change: (row: AppChatRow) => AppChatRow) =>
    setLines((prev) => prev.map((line) => ("pending" in line || line.id !== rowId ? line : change(line))));

  return {
    available: true,
    phase: "listed",
    lines,
    busy,
    sending: false,
    error: null,
    answers,
    send(text, options) {
      const pictureIds = (options?.pictures ?? []).map((blob) => {
        const id = freshId();
        sentPictures.current.set(id, URL.createObjectURL(blob));
        return id;
      });
      const replyId = options?.replyTo ?? null;
      setLines((prev) => {
        const quoted = replyId === null ? undefined : prev.find((line): line is AppChatRow => !("pending" in line) && line.id === replyId);
        const row: AppChatRow = {
          id: freshId(),
          who: "me",
          kind: pictureIds.length > 0 ? "picture" : "text",
          text: text.trim(),
          at: Date.now(),
          editable: true,
          ...(pictureIds.length > 0 ? { pics: pictureIds } : {}),
          ...(quoted !== undefined ? { replyTo: { id: quoted.id, text: quoted.text } } : {}),
        };
        return [...prev, row];
      });
      setBusy(true);
      later(() => setBusy(false), 1_200);
    },
    retry() {},
    answer(rowId, choice) {
      setAnswers((prev) => ({ ...prev, [rowId]: choice }));
      updateRow(rowId, (row) => (row.ask ? { ...row, ask: { ...row.ask, open: false } } : row));
      if (choice === "approve") {
        later(() => setLines((prev) => [...prev, texText("Sent to Sam.")]), 1_200);
      }
    },
    react(rowId, emoji: ReactionEmoji) {
      updateRow(rowId, (row) => ({
        ...row,
        reactions: [...(row.reactions ?? []).filter((r) => r.who !== "me"), { who: "me", emoji }],
      }));
    },
    edit(rowId, text) {
      updateRow(rowId, (row) => ({ ...row, text: text.trim(), edited: true }));
    },
    unsend(rowId) {
      updateRow(rowId, (row) => ({ ...row, text: "", unsent: true }));
    },
    pictureUrl(id) {
      if (id === PICTURE_ID) return PICTURE_DATA_URL;
      return sentPictures.current.get(id) ?? null;
    },
  };
}

/**
 * The right panel with the Tex tab showing. Folded, it is the product's own
 * `AsideStrip`; open, a tab row and `TexChatView`, mirroring `AsidePanel`'s
 * tab row (its styles are private to that file).
 */
function TexAside({ folded, view }: { folded: boolean; view: AppChatView }) {
  const frame = useFrame();
  const setFolded = frame.setAsideFolded;
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  useEffect(() => {
    setFolded(folded);
  }, [folded, setFolded]);

  if (frame.state.asideFolded) {
    return <AsideStrip tabs={TABS} showing="tex" recording={false} onUnfold={() => setFolded(false)} />;
  }

  return (
    <View style={styles.panel} testID="aside-panel">
      <View style={styles.tabs} accessibilityRole="tablist">
        <View style={styles.tab}>
          <Text variant="rowSub" style={styles.muted}>
            Meetings
          </Text>
        </View>
        <View style={[styles.tab, styles.tabCurrent]} accessibilityState={{ selected: true }}>
          <Text variant="rowSub" style={styles.tabLabelCurrent}>
            Tex
          </Text>
        </View>
        <View style={styles.tabsGap} />
        <Pressable
          onPress={() => setFolded(true)}
          accessibilityRole="button"
          accessibilityLabel="Fold the panel"
          style={styles.fold}
          testID="aside-fold"
        >
          <Icon name="chevronRight" size={16} color={colors.text2} />
        </Pressable>
      </View>
      <View style={styles.body} testID="aside-tex">
        <TexChatView view={view} />
      </View>
    </View>
  );
}

function TexChatBoard({ folded }: { folded: boolean }) {
  const view = useFakeTexChat();
  return <AppFrameVisualFixture panel fakeMeeting={false} aside={<TexAside folded={folded} view={view} />} />;
}

export function TexChatFixture({ params }: { params: Record<string, string | string[] | undefined> }) {
  const fold = (Array.isArray(params.fold) ? params.fold[0] : params.fold) === "1";
  return <TexChatBoard folded={fold} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { flex: 1, minWidth: 0 },
    tabs: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingHorizontal: space.x2,
      paddingTop: space.x2,
      paddingBottom: space.x1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x3,
      borderRadius: radii.control,
    },
    tabCurrent: { backgroundColor: colors.chrome },
    tabsGap: { flex: 1 },
    fold: { width: 36, minHeight: layout.minTouchTarget, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
    muted: { color: colors.muted },
    tabLabelCurrent: { color: colors.text },
    body: { flex: 1, minHeight: 0 },
  });
