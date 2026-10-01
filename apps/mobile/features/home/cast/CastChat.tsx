import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { useColors, useTheme } from "../../design/theme";
import { castChatLooks, pointerType, radii, space, type CastChatLookColors } from "../../design/tokens";
import type { ChatMessage, ChatTool, ChatWindow } from "./castChat";
import type { CastChatView } from "./useHomeCast";

/*
  A chat app that is nobody's in particular: the system's own sans, not the
  console's, so the window reads as another app beside Context rather than a
  panel of it.
*/
const SYSTEM_FONT = Platform.select({ web: "ui-sans-serif, system-ui, -apple-system, sans-serif", default: undefined });

/**
 * The chats of a scene, beside the workspace or filling the frame (Dev2,
 * 2026-09-30). One window per assistant, stacked, each showing the words
 * said, what it did under "Used Context", and its box with whatever is being
 * typed into it. Drawn from `castChat.ts`'s state; nothing here plays.
 */
export function CastChat({
  view,
  colors,
  onClose,
  one = false,
}: {
  view: CastChatView;
  /** Each cast member's colour: an assistant's badge is drawn in it. */
  colors: ReadonlyMap<string, string>;
  /** Absent on the studio's stage, which is a recording. */
  onClose?: () => void;
  /**
   * One window, the assistant the latest thing happened with, the others a
   * tab away: a phone has room for one chat under Context (Dev2, 2026-09-30).
   */
  one?: boolean;
}) {
  const look = castChatLooks[view.setup.look];
  // A visitor's pick holds until the scene moves to another assistant.
  const [picked, pick] = useState<string | null>(null);
  useEffect(() => pick(null), [view.active, view.shows]);
  if (one && view.windows.length > 0) {
    const shown =
      view.windows.find((window) => window.agent === (picked ?? chatShown(view))) ?? view.windows[view.windows.length - 1]!;
    const tabs =
      view.windows.length < 2
        ? undefined
        : view.windows.map((window) => ({
            agent: window.agent,
            badge: colors.get(window.agent) ?? look.muted,
            on: window.agent === shown.agent,
            press: () => pick(window.agent),
          }));
    return (
      <View style={styles.column} testID="cast-chat">
        <Window window={shown} look={look} badge={colors.get(shown.agent) ?? look.muted} onClose={onClose} tabs={tabs} />
      </View>
    );
  }
  return (
    <View style={styles.column} testID="cast-chat">
      {view.windows.map((window, index) => (
        <Window
          key={window.agent}
          window={window}
          look={look}
          badge={colors.get(window.agent) ?? look.muted}
          onClose={index === 0 ? onClose : undefined}
        />
      ))}
    </View>
  );
}

/** The assistant a phone's one chat window is on: the one the script cut to, or the latest to speak. */
function chatShown(view: CastChatView): string | undefined {
  return view.shows !== undefined && view.shows !== "both" && view.shows !== "context" ? view.shows : view.active;
}

interface ChatTab {
  agent: string;
  badge: string;
  on: boolean;
  press: () => void;
}

function Window({
  window,
  look,
  badge,
  onClose,
  tabs,
}: {
  window: ChatWindow;
  look: CastChatLookColors;
  badge: string;
  onClose?: () => void;
  /** The scene's assistants, when there are several and one window shows. */
  tabs?: readonly ChatTab[];
}) {
  const scroller = useRef<ScrollView>(null);
  // Its own window on the desk, never a panel of Context's (Dev2, 2026-09-30).
  const { shadows } = useTheme();
  const ink = { color: look.ink, fontFamily: SYSTEM_FONT };
  const muted = { color: look.muted, fontFamily: SYSTEM_FONT };
  return (
    <View
      style={[styles.window, { backgroundColor: look.ground, borderColor: look.line, boxShadow: shadows.window }]}
      accessibilityRole={Platform.OS === "web" ? ("region" as never) : undefined}
      aria-label={`Chat with ${window.agent}`}
      testID={`cast-chat-${window.agent}`}
    >
      <View style={[styles.head, { borderBottomColor: look.line }]}>
        {tabs === undefined ? (
          <>
            <View style={[styles.badge, { backgroundColor: badge }]} />
            <Text style={[styles.name, ink]} numberOfLines={1}>
              {window.agent}
            </Text>
          </>
        ) : (
          <View style={[styles.tabs, { backgroundColor: look.chip }]} role="tablist">
            {tabs.map((tab) => (
              <Pressable
                key={tab.agent}
                onPress={tab.press}
                role="tab"
                aria-selected={tab.on}
                style={[styles.tab, tab.on ? { backgroundColor: look.field, boxShadow: `0 1px 2px ${look.line}` } : null]}
                testID={`cast-chat-tab-${tab.agent}`}
              >
                <View style={[styles.tabBadge, { backgroundColor: tab.badge }]} />
                <Text style={[styles.tabName, tab.on ? ink : muted]} numberOfLines={1}>
                  {tab.agent}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.grow} />
        <View style={[styles.connected, { backgroundColor: look.chip }]}>
          <View style={[styles.dot, { backgroundColor: look.ok }]} />
          <Text style={[styles.small, muted]}>{tabs === undefined ? "Context connected" : "Connected"}</Text>
        </View>
        {onClose === undefined ? null : (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the chat" style={styles.close} testID="cast-chat-close">
            <Icon name="close" size={14} color={look.muted} />
          </Pressable>
        )}
      </View>
      <ScrollView
        ref={scroller}
        style={styles.grow}
        contentContainerStyle={styles.messages}
        // The newest is what the film is about: keep it in view as it grows.
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
      >
        {window.messages.map((message, index) => (
          <Message key={keyOf(message, index)} message={message} look={look} />
        ))}
      </ScrollView>
      <View style={styles.foot}>
        <View style={[styles.box, { borderColor: look.line, backgroundColor: look.field }]}>
          <Text style={[styles.words, window.draft === "" ? muted : ink, styles.grow]} numberOfLines={3} testID={`cast-chat-draft-${window.agent}`}>
            {window.draft === "" ? "Message…" : window.draft}
          </Text>
          <View style={[styles.send, { backgroundColor: look.chip }]}>
            <Icon name="arrowRight" size={14} color={look.muted} />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The top of Context's own window while a chat scene plays: the app's name,
 * and which assistant is reaching it from the chat beside it ("Claude, from
 * chat"), so the two read as two apps talking rather than one app with a chat
 * panel (Dev2, 2026-09-30).
 */
export function CastWorkspaceBar({ view }: { view: CastChatView }) {
  const colors = useColors();
  const from = view.windows
    .filter((window) => window.messages.some((message) => message.kind === "tools"))
    .map((window) => window.agent);
  return (
    <View style={[styles.bar, { backgroundColor: colors.chromeSurface, borderBottomColor: colors.line }]} testID="cast-workspace-bar">
      <Text style={[styles.barName, { color: colors.text }]}>Context</Text>
      <View style={styles.grow} />
      {from.length === 0 ? null : (
        <View style={[styles.from, { backgroundColor: colors.hintWash, borderColor: colors.hintBorder }]}>
          <View style={[styles.dot, { backgroundColor: colors.hintText }]} />
          <Text style={[styles.small, styles.fromText, { color: colors.hintText }]} numberOfLines={1}>
            {`${from.join(" and ")}, from chat`}
          </Text>
        </View>
      )}
    </View>
  );
}

function keyOf(message: ChatMessage, index: number): string {
  if (message.kind === "answer") return `answer-${message.id}`;
  if (message.kind === "tools") return `tools-${message.tools[0]?.id ?? index}`;
  return `asked-${index}`;
}

function Message({ message, look }: { message: ChatMessage; look: CastChatLookColors }) {
  const ink = { color: look.ink, fontFamily: SYSTEM_FONT };
  if (message.kind === "asked") {
    return (
      <View style={[styles.bubble, { backgroundColor: look.bubble }]}>
        <Text style={[styles.words, ink]}>{message.text}</Text>
      </View>
    );
  }
  if (message.kind === "answer") return <Text style={[styles.words, ink]}>{message.text}</Text>;
  const done = message.tools.filter((tool) => tool.done).length;
  return (
    <View style={[styles.card, { borderColor: look.line }]} testID="cast-chat-tools">
      <View style={[styles.cardHead, { backgroundColor: look.chip }]}>
        <Text style={[styles.cardTitle, ink]}>Used Context</Text>
        <View style={styles.grow} />
        <Text style={[styles.small, { color: look.muted, fontFamily: SYSTEM_FONT }]}>
          {done === message.tools.length ? `${done} ${done === 1 ? "step" : "steps"}` : `${done} of ${message.tools.length}`}
        </Text>
      </View>
      {message.tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} look={look} />
      ))}
    </View>
  );
}

function ToolRow({ tool, look }: { tool: ChatTool; look: CastChatLookColors }) {
  return (
    <View
      style={[styles.tool, { borderTopColor: look.line }, tool.done ? null : { backgroundColor: look.landing }]}
      aria-busy={!tool.done}
    >
      {tool.done ? (
        <Icon name="check" size={13} color={look.ok} />
      ) : (
        <ActivityIndicator size="small" color={look.muted} style={styles.spinner} />
      )}
      <Text style={[styles.toolText, { color: look.ink, fontFamily: SYSTEM_FONT }]} numberOfLines={2}>
        {tool.verb} <Text style={{ color: look.muted }}>{tool.what}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.x2, height: 40, paddingHorizontal: space.x4, borderBottomWidth: 1 },
  barName: { fontSize: pointerType.ui, fontWeight: "600" },
  from: { flexDirection: "row", alignItems: "center", gap: space.x1, paddingHorizontal: space.x2, paddingVertical: 3, borderRadius: radii.pill, borderWidth: 1, flexShrink: 1 },
  fromText: { fontWeight: "600" },
  column: { flex: 1, gap: space.x3, minHeight: 0, minWidth: 0 },
  window: { flex: 1, minHeight: 0, borderRadius: radii.console, borderWidth: 1, overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 48, paddingHorizontal: space.x4, borderBottomWidth: 1 },
  badge: { width: 20, height: 20, borderRadius: 10 },
  tabs: { flexDirection: "row", gap: 2, padding: 3, borderRadius: radii.pill, flexShrink: 1 },
  tab: { flexDirection: "row", alignItems: "center", gap: space.x1, minHeight: 30, paddingHorizontal: space.x2, borderRadius: radii.pill },
  tabBadge: { width: 12, height: 12, borderRadius: 6 },
  tabName: { fontSize: pointerType.ui, fontWeight: "600" },
  name: { fontSize: pointerType.lede, fontWeight: "600", flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  connected: { flexDirection: "row", alignItems: "center", gap: space.x1, paddingHorizontal: space.x2, paddingVertical: 3, borderRadius: radii.pill },
  dot: { width: 6, height: 6, borderRadius: 3 },
  small: { fontSize: pointerType.meta },
  close: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.pill },
  messages: { gap: space.x3, padding: space.x4 },
  bubble: { alignSelf: "flex-end", maxWidth: "85%", paddingHorizontal: space.x3, paddingVertical: space.x2, borderRadius: radii.control },
  words: { fontSize: pointerType.lede, lineHeight: 22 },
  card: { borderWidth: 1, borderRadius: radii.card, overflow: "hidden" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 34, paddingHorizontal: space.x3 },
  cardTitle: { fontSize: pointerType.ui, fontWeight: "600" },
  tool: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 32, paddingHorizontal: space.x3, paddingVertical: space.x1, borderTopWidth: 1 },
  spinner: { width: 13, height: 13, transform: [{ scale: 0.6 }] },
  toolText: { flex: 1, fontSize: pointerType.ui },
  foot: { padding: space.x3 },
  box: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 44, paddingLeft: space.x3, paddingRight: space.x1, borderWidth: 1, borderRadius: radii.control },
  send: { width: 32, height: 32, borderRadius: radii.xl, alignItems: "center", justifyContent: "center" },
});
