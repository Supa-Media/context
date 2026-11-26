/**
 * One conversation on the Mail page: the note's mail read like a thread, and a box that adds to it. Writing here is
 * mail, never a chat (the owner, 2026-11-25: "make it clear in the UI that its not a chat, and that its mail, because
 * we wont be able to see into its thinking, stream, etc"): the line is appended to the note's ```mail block, signed
 * with the reader's `@handle`, and whoever holds the area or the bot is told by the workspace, as for any new line.
 */

import { appendMail, parseMail, type MailEvent } from "@context/shared/src/mail.cjs";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../design/components/Text";
import { useFieldFont } from "../../design/fieldFont";
import { pointerType, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { timeLabel } from "../files/mail/model";
import { isMe, nameOf, type Conversation } from "./model";

/** How the page reads a note and writes it back: the app's own note reads and saves (`useMailIO`). */
export interface MailNoteIO {
  read(path: string): Promise<{ text: string; etag: string; readOnly: boolean; encrypted?: boolean }>;
  write(path: string, text: string, expectedEtag: string): Promise<unknown>;
}

/** `text` with `entry` appended to its mail block, or the reason it cannot be. */
export function withMail(text: string, from: string, words: string): { text: string } | { error: string } {
  const result = appendMail(text, { from, kind: "mail", to: "everyone", text: words });
  if (result.error !== undefined) return { error: result.error };
  let out = text;
  for (const change of [...result.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return { text: out };
}

/** Who the reply box reaches, in words: a bot's own mail, an area's holder, or everyone on the note. */
function reachWords(conversation: Conversation): string {
  if (conversation.place.kind === "bot") return `Mail, not a chat. ${nameOf(conversation.place.bot)} is told now and answers here when it answers; its thinking stays in its own app.`;
  if (conversation.place.kind === "area") return "Mail, not a chat. Whoever holds the area is told now and answers here when it answers.";
  return "Mail, not a chat. Everyone who joined this note's mail reads it here.";
}

type Read = { status: "reading" } | { status: "failed" } | { status: "sealed" } | { status: "read"; events: readonly MailEvent[]; readOnly: boolean };

export function MailThread({
  conversation,
  io,
  me,
  onOpenNote,
  onSent,
  onBack,
}: {
  conversation: Conversation;
  io: MailNoteIO;
  me?: string;
  onOpenNote: (path: string) => void;
  onSent: () => void;
  onBack?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const [read, setRead] = useState<Read>({ status: "reading" });
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const path = conversation.path;

  const load = useCallback(async () => {
    try {
      const note = await io.read(path);
      if (note.encrypted === true) return setRead({ status: "sealed" });
      setRead({ status: "read", events: parseMail(note.text).events, readOnly: note.readOnly });
    } catch {
      setRead({ status: "failed" });
    }
  }, [io, path]);
  useEffect(() => {
    void load();
  }, [load, conversation.last?.at]);

  const send = async () => {
    if (me === undefined || sending || words.trim() === "") return;
    setSending(true);
    setProblem(null);
    try {
      // Read again just before writing, and pass its version back, so a line that landed meanwhile is never lost;
      // a version that moved under us is read once more and tried again.
      for (let attempt = 0; ; attempt += 1) {
        const note = await io.read(path);
        const next = withMail(note.text, me, words);
        if ("error" in next) {
          setProblem(next.error);
          return;
        }
        try {
          await io.write(path, next.text, note.etag);
          break;
        } catch (error) {
          if (attempt >= 1) throw error;
        }
      }
      setWords("");
      await load();
      onSent();
    } catch {
      setProblem("That didn't send. Try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  const messages = read.status === "read" ? read.events.filter((event) => event.kind === "mail") : [];
  const canWrite = me !== undefined && read.status === "read" && !read.readOnly;
  return (
    <View style={styles.thread} testID="mail-thread">
      <View style={styles.head}>
        {onBack !== undefined ? (
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to Mail" style={styles.back} testID="mail-back">
            <Text variant="treeMeta" style={styles.link}>
              ‹ Mail
            </Text>
          </Pressable>
        ) : null}
        <Text variant="tree" style={styles.title} numberOfLines={1}>
          {conversation.title}
        </Text>
        <Pressable onPress={() => onOpenNote(path)} accessibilityRole="link" testID="mail-open-note">
          <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
            {`${conversation.where} · open the note`}
          </Text>
        </Pressable>
      </View>
      <ScrollView style={styles.messages} contentContainerStyle={styles.messagesInner}>
        {read.status === "reading" ? <Text variant="treeMeta" style={styles.muted}>Reading…</Text> : null}
        {read.status === "failed" ? <Text variant="treeMeta" style={styles.muted}>This mail couldn't be read just now.</Text> : null}
        {read.status === "sealed" ? <Text variant="treeMeta" style={styles.muted}>This note is encrypted: open it to read its mail.</Text> : null}
        {messages.map((event) => {
          const mine = isMe(event.from, me);
          return (
            <View key={`${event.at}|${event.from}|${event.start}`} style={[styles.message, mine && styles.mine]} testID="mail-message">
              <Text variant="treeMeta" style={styles.muted}>
                {`${mine ? "You" : nameOf(event.from)}${event.app ? ` (${event.app})` : ""} · ${timeLabel(event.at)}${event.to && event.to !== "everyone" ? ` · to ${nameOf(event.to)}` : ""}${event.used !== null ? ` · used ${event.used}%` : ""}`}
              </Text>
              <Text variant="tree" selectable>
                {event.text}
              </Text>
            </View>
          );
        })}
      </ScrollView>
      <View style={styles.box}>
        <TextInput
          value={words}
          onChangeText={(next) => {
            setWords(next);
            setProblem(null);
          }}
          multiline
          editable={canWrite && !sending}
          accessibilityLabel={`Write to ${conversation.other}`}
          placeholder={canWrite ? `Write to ${conversation.other}…` : "You can read this mail but not write in it."}
          placeholderTextColor={colors.muted}
          style={[styles.input, fieldFont]}
          testID="mail-input"
        />
        <View style={styles.boxFoot}>
          <Text variant="treeMeta" style={[styles.muted, styles.grow]} testID="mail-not-chat">
            {problem ?? reachWords(conversation)}
          </Text>
          <Pressable
            onPress={() => void send()}
            disabled={!canWrite || sending || words.trim() === ""}
            accessibilityRole="button"
            accessibilityLabel="Send mail"
            style={[styles.send, (!canWrite || sending || words.trim() === "") && styles.sendOff]}
            testID="mail-send"
          >
            <Text variant="treeMeta" style={styles.sendWord}>
              {sending ? "Sending…" : "Send"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    thread: { flex: 1, minHeight: 0 },
    head: { paddingHorizontal: space.x4, paddingVertical: space.x2, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    back: { paddingVertical: space.x1 },
    link: { color: colors.accent },
    title: { fontWeight: "600" },
    muted: { color: colors.muted },
    messages: { flex: 1 },
    messagesInner: { padding: space.x4, gap: space.x3 },
    message: { gap: 2, maxWidth: 640 },
    mine: { alignSelf: "flex-end" },
    box: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, padding: space.x3, gap: space.x2 },
    input: { minHeight: 44, maxHeight: 160, borderWidth: 1, borderColor: colors.line, borderRadius: radii.sm, paddingHorizontal: space.x2, paddingVertical: space.x2, color: colors.text },
    boxFoot: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flexGrow: 1, flexShrink: 1 },
    send: { paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.pill, backgroundColor: colors.accent },
    sendOff: { opacity: 0.4 },
    sendWord: { color: colors.ground, fontWeight: "600" },
  });
