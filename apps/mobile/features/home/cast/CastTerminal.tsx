import { useRef } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { useTheme } from "../../design/theme";
import { fonts, pointerType, radii, space, type CastTerminalLookColors } from "../../design/tokens";
import type { ChatMessage, ChatTool, ChatWindow } from "./castChat";
import { SYSTEM_FONT, diffCount, diffSide, outputTone } from "./castLook";

/** One of a scene's assistants, as a tab across the top of the one window a phone shows. */
export interface ChatTab {
  agent: string;
  badge: string;
  on: boolean;
  press: () => void;
}

/**
 * An assistant at work in a terminal (Dev2, 2026-10-01): what it was asked,
 * the commands it ran and what they printed, its edits as diffs, a command
 * it is waiting for somebody to allow, and its Context work as rows of their
 * own, so the eye goes from "Marked Checkout v2 as done" to the project
 * changing beside it. Drawn from `castChat.ts`'s state; nothing here plays.
 * The look is nobody's product: a dark window, a monospaced face, the
 * assistant's name and the folder it is in.
 */
export function CastTerminal({
  window,
  folder,
  look,
  compact,
  onClose,
  tabs,
}: {
  window: ChatWindow;
  folder: string;
  look: CastTerminalLookColors;
  /** A phone: a size smaller, so a command fits on its line. */
  compact: boolean;
  onClose?: () => void;
  tabs?: readonly ChatTab[];
}) {
  const scroller = useRef<ScrollView>(null);
  const { shadows } = useTheme();
  const size = compact ? pointerType.meta : pointerType.ui;
  const text = { fontFamily: fonts.mono, fontSize: size, lineHeight: Math.round(size * 1.45) };
  const waiting = window.messages.some((message) => message.kind === "approval" && message.answer === "waiting");
  const running = window.messages.some((message) => message.kind === "run" && !message.done);
  return (
    <View
      style={[styles.window, { backgroundColor: look.ground, borderColor: look.line, boxShadow: shadows.window }]}
      accessibilityRole={Platform.OS === "web" ? ("region" as never) : undefined}
      aria-label={`${window.agent} in a terminal`}
      testID={`cast-terminal-${window.agent}`}
    >
      <View style={[styles.head, { borderBottomColor: look.line }]}>
        {tabs === undefined ? (
          <>
            <Text style={[styles.name, { color: look.accent }]} numberOfLines={1}>
              {window.agent}
            </Text>
            <Text style={[styles.folder, { color: look.muted }]} numberOfLines={1}>
              {folder}
            </Text>
          </>
        ) : (
          <View style={[styles.tabs, { backgroundColor: look.raised }]} role="tablist">
            {tabs.map((tab) => (
              <Pressable
                key={tab.agent}
                onPress={tab.press}
                role="tab"
                aria-selected={tab.on}
                style={[styles.tab, tab.on ? { backgroundColor: look.line } : null]}
                testID={`cast-chat-tab-${tab.agent}`}
              >
                <View style={[styles.tabBadge, { backgroundColor: tab.badge }]} />
                <Text style={[styles.tabName, { color: tab.on ? look.bright : look.muted }]} numberOfLines={1}>
                  {tab.agent}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.grow} />
        <View style={[styles.dot, { backgroundColor: look.ok }]} />
        <Text style={[styles.connected, { color: look.muted }]} numberOfLines={1}>
          {compact ? "Context" : "Context connected"}
        </Text>
        {onClose === undefined ? null : (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the terminal" style={styles.close} testID="cast-chat-close">
            <Icon name="close" size={14} color={look.muted} />
          </Pressable>
        )}
      </View>
      <ScrollView
        ref={scroller}
        style={styles.grow}
        contentContainerStyle={[styles.lines, compact ? styles.linesCompact : null]}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        // A window that shrinks (another opening beside it) keeps its newest line in view too.
        onLayout={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {window.messages.map((message, index) => (
          <Entry key={keyOf(message, index)} message={message} look={look} text={text} compact={compact} />
        ))}
      </ScrollView>
      <View style={[styles.prompt, { borderColor: look.line }]} testID={`cast-terminal-prompt-${window.agent}`}>
        <Text style={[text, { color: look.accent }]}>›</Text>
        {window.draft !== "" ? (
          <Text style={[text, styles.grow, { color: look.bright }]} numberOfLines={3} testID={`cast-chat-draft-${window.agent}`}>
            {window.draft}
            <Text style={{ color: look.accent }}>▍</Text>
          </Text>
        ) : (
          <Text style={[text, styles.grow, { color: look.muted }]} numberOfLines={1}>
            {waiting ? "Waiting for approval" : running ? "Working…" : <Text style={{ color: look.accent }}>▍</Text>}
          </Text>
        )}
      </View>
    </View>
  );
}

type Mono = { fontFamily: string | undefined; fontSize: number; lineHeight: number };

function keyOf(message: ChatMessage, index: number): string {
  if (message.kind === "tools") return `tools-${message.tools[0]?.id ?? index}`;
  if ("id" in message) return `${message.kind}-${message.id}`;
  return `asked-${index}`;
}

/** A row's lead: the bullet every step a terminal shows starts with. */
function Bullet({ look, text, busy = false }: { look: CastTerminalLookColors; text: Mono; busy?: boolean }) {
  return <Text style={[text, styles.bullet, { color: busy ? look.muted : look.accent }]}>{busy ? "◦" : "•"}</Text>;
}

function Entry({ message, look, text, compact }: { message: ChatMessage; look: CastTerminalLookColors; text: Mono; compact: boolean }) {
  switch (message.kind) {
    case "asked":
      return (
        <View style={[styles.asked, { backgroundColor: look.raised }]}>
          <Text style={[text, { color: look.accent }]}>›</Text>
          <Text style={[text, styles.grow, { color: look.bright }]}>{message.text}</Text>
        </View>
      );
    case "answer":
      return (
        <View style={styles.row}>
          <Bullet look={look} text={text} />
          <Text style={[text, styles.grow, { color: look.ink, fontFamily: SYSTEM_FONT, fontSize: text.fontSize + 1 }]}>{message.text}</Text>
        </View>
      );
    case "tools":
      return (
        <View style={styles.group}>
          {message.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} look={look} text={text} />
          ))}
        </View>
      );
    case "run":
      return (
        <View style={styles.group} testID="cast-terminal-run">
          <View style={styles.row}>
            <Bullet look={look} text={text} busy={!message.done} />
            <Text style={[text, styles.grow, { color: look.ink }]}>
              {message.done ? "Ran " : "Running "}
              <Text style={{ color: look.bright }}>{message.command}</Text>
            </Text>
          </View>
          {message.output.map((line, index) => (
            // A row, so a line that wraps stays under its own first word.
            <View key={index} style={[styles.row, styles.out, compact ? styles.outCompact : null]}>
              <Text style={[text, styles.elbow, { color: look.muted }]}>{index === 0 ? "└" : ""}</Text>
              <Text style={[text, styles.grow, { color: toneColor(outputTone(line), look) }]}>{line}</Text>
            </View>
          ))}
        </View>
      );
    case "edit":
      return (
        <View style={styles.group} testID="cast-terminal-edit">
          <View style={styles.row}>
            <Bullet look={look} text={text} />
            <Text style={[text, styles.grow, { color: look.ink }]}>
              Edited <Text style={{ color: look.bright }}>{message.file}</Text> <Text style={{ color: look.muted }}>{diffCount(message.diff)}</Text>
            </Text>
          </View>
          <View style={[styles.diff, compact ? styles.outCompact : null, { borderLeftColor: look.line }]}>
            {message.diff.map((line, index) => {
              const side = diffSide(line);
              return (
                <Text key={index} style={[text, { color: side === "add" ? look.add : side === "remove" ? look.remove : look.muted }]}>
                  {side === "remove" ? `−${line.slice(1)}` : line}
                </Text>
              );
            })}
          </View>
        </View>
      );
    case "approval":
      return message.answer === "waiting" ? (
        <View style={[styles.ask, { backgroundColor: look.raised, borderColor: look.ask }]} testID="cast-terminal-approval">
          <Text style={[styles.askTitle, { color: look.bright }]}>Run this command?</Text>
          <Text style={[text, { color: look.accent }]}>{message.command}</Text>
          <View style={styles.buttons}>
            <View style={[styles.button, { backgroundColor: look.accent }]}>
              <Text style={[styles.buttonText, { color: look.onAccent, fontWeight: "700" }]}>Yes</Text>
            </View>
            {["Always", "No"].map((label) => (
              <View key={label} style={[styles.button, { borderColor: look.ask, borderWidth: 1 }]}>
                <Text style={[styles.buttonText, { color: look.ink }]}>{label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.row} testID="cast-terminal-approval">
          <Text style={[text, styles.bullet, { color: message.answer === "allowed" ? look.ok : look.fail }]}>
            {message.answer === "allowed" ? "✓" : "✗"}
          </Text>
          <Text style={[text, styles.grow, { color: look.muted }]}>
            {message.by ?? "Somebody"} {message.answer === "allowed" ? "allowed" : "denied"} <Text style={{ color: look.ink }}>{message.command}</Text>
          </Text>
        </View>
      );
  }
}

/** A step it took in Context, said the way the terminal says its own: "Marked context Checkout v2 as done". */
function ToolRow({ tool, look, text }: { tool: ChatTool; look: CastTerminalLookColors; text: Mono }) {
  return (
    <View style={styles.row} aria-busy={!tool.done}>
      <Bullet look={look} text={text} busy={!tool.done} />
      <Text style={[text, styles.grow, { color: tool.done ? look.ink : look.muted }]}>
        {tool.verb} <Text style={{ color: look.accent }}>context</Text> <Text style={{ color: look.bright }}>{tool.what}</Text>
      </Text>
    </View>
  );
}

function toneColor(tone: "ok" | "fail" | "plain", look: CastTerminalLookColors): string {
  return tone === "ok" ? look.ok : tone === "fail" ? look.fail : look.muted;
}

const styles = StyleSheet.create({
  window: { flex: 1, minHeight: 0, borderRadius: radii.console, borderWidth: 1, overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 44, paddingHorizontal: space.x4, borderBottomWidth: 1 },
  name: { fontFamily: SYSTEM_FONT, fontSize: pointerType.ui, fontWeight: "700", flexShrink: 0 },
  folder: { fontFamily: fonts.mono, fontSize: pointerType.meta, flexShrink: 1 },
  tabs: { flexDirection: "row", gap: 2, padding: 3, borderRadius: radii.pill, flexShrink: 1 },
  tab: { flexDirection: "row", alignItems: "center", gap: space.x1, minHeight: 28, paddingHorizontal: space.x2, borderRadius: radii.pill },
  tabBadge: { width: 10, height: 10, borderRadius: 5 },
  tabName: { fontFamily: SYSTEM_FONT, fontSize: pointerType.ui, fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  connected: { fontFamily: SYSTEM_FONT, fontSize: pointerType.meta },
  close: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radii.pill },
  lines: { gap: space.x2, padding: space.x4 },
  linesCompact: { padding: space.x3 },
  asked: { flexDirection: "row", gap: space.x2, paddingHorizontal: space.x2, paddingVertical: space.x1, borderRadius: radii.control },
  row: { flexDirection: "row", gap: space.x2 },
  bullet: { width: 10 },
  group: { gap: 2 },
  out: { paddingLeft: space.x4, gap: space.x1 },
  elbow: { width: 10 },
  outCompact: { paddingLeft: space.x3 },
  diff: { marginLeft: space.x4, paddingLeft: space.x2, borderLeftWidth: 1 },
  ask: { gap: space.x2, padding: space.x3, borderWidth: 1, borderRadius: radii.card },
  askTitle: { fontFamily: SYSTEM_FONT, fontSize: pointerType.ui, fontWeight: "600" },
  buttons: { flexDirection: "row", gap: space.x2 },
  button: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.control },
  buttonText: { fontFamily: SYSTEM_FONT, fontSize: pointerType.ui },
  prompt: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 40, margin: space.x3, marginTop: 0, paddingHorizontal: space.x3, borderWidth: 1, borderRadius: radii.control },
});
