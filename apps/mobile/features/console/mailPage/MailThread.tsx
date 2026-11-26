/**
 * One conversation on Agent Mail: the note's mail read like a thread, and a box that adds to it. Writing here is mail,
 * never a chat: the line is appended to the note's ```mail block, signed with the reader's `@handle`, and whoever holds
 * the area or the bot is told by the workspace, as for any new line. The page's name says it is mail with agents, so
 * the box carries no note saying so (Dev2, 2026-11-26, on the old footer line: "unnecessary").
 *
 * Read Slack style (Dev2, 2026-11-26): every message left-aligned under a header with the sender's face, name and
 * time, a run from one sender under one header, a line between days. The head names the people in the mail by face,
 * a bot by its own logo from its card, and links the note; it never shows the file's path.
 */

import { appendMail, parseMail, splitApp, type MailEvent } from "@context/shared/src/mail.cjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../design/components/Text";
import { useFieldFont } from "../../design/fieldFont";
import { pointerType, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { OwnerFace } from "../files/folderPage/Glyphs";
import { AccessoryGlyph } from "../files/AccessoryGlyph";
import type { FaceOf } from "./useBotFaces";
import { readByWords, receiptsFor, type MailRead, type Receipt } from "./receipts";
import { cardSlug } from "../files/folderPage/areas/seat";
import { clockLabel, isMe, isPersonName, messageLines, nameOf, sideName, usedThisWeek, type Conversation } from "./model";

/** How the page reads a note and writes it back: the app's own note reads and saves (`useMailIO`). */
export interface MailNoteIO {
  read(path: string): Promise<{ text: string; etag: string; readOnly: boolean; encrypted?: boolean }>;
  write(path: string, text: string, expectedEtag: string): Promise<unknown>;
  /** A picture named on a note (a bot's logo on its card), as a `src`; absent where pictures can't be read. */
  picture?(notePath: string, leaf: string): Promise<string | null>;
  /** The picture's cache key: the stored picture's name is a hash of its bytes. */
  pictureKey?(leaf: string): string;
  /** Keeps the reader's read of the note's mail and answers who has read it; absent, or null, where it can't. */
  reads?(path: string): Promise<readonly MailRead[] | null>;
}

/** How often an open conversation asks again who has read it. */
export const READS_REFRESH_MS = 60_000;

/** `Claude Code · @seyi` as a line's header says it: "@seyi's Claude Code"; an app signed alone, as it is. */
export function appWords(signed: string | null | undefined): string | null {
  const { app, owner } = splitApp(signed ?? null);
  if (app === null) return null;
  return owner === null ? app : `${owner}'s ${app}`;
}

/** `text` with `entry` appended to its mail block, or the reason it cannot be. */
export function withMail(text: string, from: string, words: string): { text: string } | { error: string } {
  const result = appendMail(text, { from, kind: "mail", to: "everyone", text: words });
  if (result.error !== undefined) return { error: result.error };
  let out = text;
  for (const change of [...result.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return { text: out };
}

/** The height of the page's one header row: the list's head on the left, the thread's on the right (`MailPage`). */
export const MAIL_BAR = 92;

/** "You and Grok Bot", "@shyoh, Finance and You". */
function listedNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

type Read = { status: "reading" } | { status: "failed" } | { status: "sealed" } | { status: "read"; events: readonly MailEvent[]; readOnly: boolean };

export function MailThread({
  conversation,
  io,
  me,
  onOpenNote,
  onSent,
  onBack,
  onClose,
  faceOf,
}: {
  conversation: Conversation;
  io: MailNoteIO;
  /** The face for a name in this mail, and the app its line was signed with: the page's, shared with its list (`useBotFaces`). */
  faceOf: FaceOf;
  me?: string;
  onOpenNote: (path: string) => void;
  onSent: () => void;
  onBack?: () => void;
  /** On a wide page the thread's head is the page's header row on the right, and Close sits in it. */
  onClose?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const [read, setRead] = useState<Read>({ status: "reading" });
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const path = conversation.path;
  const bot = conversation.place.kind === "bot" ? conversation.place.bot : null;

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

  // Who has read this mail: opening it keeps this reader's read too, and it is asked again while it stays open.
  const [reads, setReads] = useState<readonly MailRead[]>([]);
  useEffect(() => {
    setReads([]);
    if (io.reads === undefined) return;
    let live = true;
    const ask = () => void io.reads?.(path).then((answer) => live && answer !== null && setReads(answer)).catch(() => undefined);
    ask();
    const timer = setInterval(ask, READS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [io, path, conversation.last?.at]);

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

  const messages = useMemo(() => (read.status === "read" ? read.events.filter((event) => event.kind === "mail") : []), [read]);
  const lines = useMemo(() => messageLines(messages), [messages]);
  const receipts = useMemo(() => receiptsFor(messages, reads, me), [messages, reads, me]);
  // A name's app in this mail, its newest line's, for its face in the head.
  const appOf = useCallback((name: string) => [...messages].reverse().find((event) => event.from === name)?.app ?? conversation.apps?.[name] ?? null, [messages, conversation.apps]);
  // What the agents here said they used, on every line and added up for this week (Dev2, 2026-11-26: "crucial").
  const weekUsed = useMemo(() => usedThisWeek(messages), [messages]);
  const inMailFolder = conversation.place.kind !== "note";
  // Who is in this mail: the names that joined, else whoever wrote; the bot first, the reader last.
  const people = useMemo(() => {
    const names = conversation.joined.length > 0 ? [...conversation.joined] : [...new Set(messages.map((event) => event.from))];
    if (bot !== null && !names.some((name) => cardSlug(name) === bot)) names.unshift(bot);
    const rank = (name: string) => (bot !== null && cardSlug(name) === bot ? 0 : isMe(name, me) ? 2 : 1);
    return names.sort((a, b) => rank(a) - rank(b));
  }, [conversation.joined, messages, bot, me]);
  const canWrite = me !== undefined && read.status === "read" && !read.readOnly;
  const cantSend = !canWrite || sending || words.trim() === "";
  return (
    <View style={styles.thread} testID="mail-thread">
      {onBack !== undefined ? (
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to Agent Mail" style={styles.back} testID="mail-back">
          <Text variant="treeMeta" style={styles.link}>
            ‹ Agent Mail
          </Text>
        </Pressable>
      ) : null}
      <View style={[styles.head, onClose !== undefined && styles.headBar]}>
        <View style={styles.faces} aria-hidden>
          {people.slice(0, 3).map((name, at) => (
            <View key={name} style={at === 0 ? undefined : styles.faceBehind}>
              <OwnerFace face={faceOf(name, appOf(name))} size={at === 0 ? 34 : 24} />
            </View>
          ))}
        </View>
        <View style={styles.grow}>
          <Text variant="tree" style={styles.title} numberOfLines={1}>
            {conversation.other === "everyone on this note" ? conversation.title : conversation.other}
          </Text>
          <Text variant="treeMeta" style={styles.muted} numberOfLines={1} testID="mail-people">
            {listedNames(people.map((name) => sideName(name, me)))}
          </Text>
        </View>
        {weekUsed !== null ? (
          <View style={styles.weekUsed} testID="mail-week-used">
            <Text variant="treeMeta" style={styles.weekUsedNumber}>{`${weekUsed}%`}</Text>
            <Text variant="treeMeta" style={styles.muted}>
              used this week
            </Text>
          </View>
        ) : null}
        <Pressable onPress={() => onOpenNote(path)} accessibilityRole="link" style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.openNote, hovered && styles.hover]} testID="mail-open-note">
          <Text variant="treeMeta">Open note</Text>
        </Pressable>
        {onClose !== undefined ? (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close Agent Mail" style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.close, hovered && styles.hover]} testID="mail-close">
            <Text variant="treeMeta" style={styles.muted}>
              Close
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.messages} contentContainerStyle={styles.messagesInner}>
        {read.status === "reading" ? <Text variant="treeMeta" style={[styles.muted, styles.notice]}>Reading…</Text> : null}
        {read.status === "failed" ? <Text variant="treeMeta" style={[styles.muted, styles.notice]}>This mail couldn't be read just now.</Text> : null}
        {read.status === "sealed" ? <Text variant="treeMeta" style={[styles.muted, styles.notice]}>This note is encrypted: open it to read its mail.</Text> : null}
        {lines.map(({ event, header, day }, index) => (
          <View key={`${event.at}|${event.from}|${event.start}`}>
            {day !== null ? (
              <View style={styles.day} testID="mail-day">
                <View style={styles.dayRule} />
                <Text variant="treeMeta" style={styles.dayWord}>
                  {day}
                </Text>
                <View style={styles.dayRule} />
              </View>
            ) : null}
            <View style={[styles.message, header && styles.messageFirst]} testID="mail-message">
              <View style={styles.gutter}>{header ? <OwnerFace face={faceOf(event.from, event.app)} size={32} /> : null}</View>
              <View style={styles.body}>
                {header ? (
                  <View style={styles.sender}>
                    <Text variant="tree" style={styles.name}>
                      {isMe(event.from, me) ? "You" : nameOf(event.from)}
                    </Text>
                    {event.app ? <Text variant="treeMeta" style={styles.muted}>{appWords(event.app)}</Text> : null}
                    <Text variant="treeMeta" style={styles.muted}>
                      {clockLabel(event.at)}
                      {event.to && event.to !== "everyone" ? ` · to ${nameOf(event.to)}` : ""}
                    </Text>
                    {event.used !== null ? (
                      <View style={styles.usage} testID="mail-used">
                        <Text variant="treeMeta" style={styles.usageWord}>{`used ${event.used}% of its week`}</Text>
                      </View>
                    ) : !isPersonName(event.from) && inMailFolder ? (
                      <View style={[styles.usage, styles.usageMissing]} testID="mail-used-missing">
                        <Text variant="treeMeta" style={styles.usageMissingWord}>usage not said</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
                <Text variant="tree" style={styles.words} selectable>
                  {event.text}
                </Text>
              </View>
            </View>
            <ReadReceipt receipt={receipts.get(index)} faceOf={faceOf} />
          </View>
        ))}
      </ScrollView>
      <View style={styles.box}>
        <View style={styles.field}>
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
            style={[styles.input, fieldFont, sending && styles.inputSending]}
            testID="mail-input"
          />
          <Pressable
            onPress={() => void send()}
            disabled={cantSend}
            accessibilityRole="button"
            accessibilityLabel={sending ? "Sending mail" : "Send mail"}
            accessibilityState={{ disabled: cantSend, busy: sending }}
            style={[styles.send, cantSend && !sending && styles.sendOff]}
            testID="mail-send"
          >
            {sending ? <ActivityIndicator size="small" color={colors.ground} testID="mail-sending" /> : <AccessoryGlyph name="mail" size={20} color={colors.ground} />}
          </Pressable>
        </View>
        {problem !== null ? (
          <Text variant="treeMeta" style={styles.problem} testID="mail-problem">
            {problem}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    thread: { flex: 1, minHeight: 0 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingHorizontal: space.x4, paddingVertical: space.x2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    headBar: { height: MAIL_BAR, paddingVertical: 0 },
    faces: { flexDirection: "row", alignItems: "flex-end" },
    faceBehind: { marginLeft: -10, borderRadius: 999, borderWidth: 2, borderColor: colors.pageSurface },
    back: { paddingHorizontal: space.x4, paddingTop: space.x2 },
    hover: { backgroundColor: colors.chrome },
    close: { paddingVertical: space.x1, paddingHorizontal: space.x2, borderRadius: radii.control },
    link: { color: colors.accent },
    title: { fontWeight: "600", fontSize: pointerType.body },
    muted: { color: colors.muted },
    grow: { flexGrow: 1, flexShrink: 1, gap: 2 },
    openNote: { paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    messages: { flex: 1 },
    messagesInner: { paddingVertical: space.x3 },
    notice: { paddingHorizontal: space.x4 },
    day: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4, paddingVertical: space.x2 },
    dayRule: { flexGrow: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
    dayWord: { color: colors.muted, fontWeight: "600" },
    message: { flexDirection: "row", gap: space.x3, paddingHorizontal: space.x4, paddingVertical: 2 },
    messageFirst: { paddingTop: space.x3 },
    gutter: { width: 32 },
    body: { flex: 1, minWidth: 0, maxWidth: 720, gap: 2 },
    sender: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: space.x2 },
    name: { fontWeight: "700" },
    words: { lineHeight: 21 },
    box: { paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x3, gap: space.x1 },
    field: { flexDirection: "row", alignItems: "flex-end", gap: space.x2, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, paddingLeft: space.x3, paddingRight: space.x2, paddingVertical: space.x2 },
    input: { flex: 1, minHeight: 28, maxHeight: 160, paddingVertical: space.x1, color: colors.text },
    // A square key with the mail mark (Dev, 2026-11-26: "replace the send icon with a mail icon"); bigger on a phone.
    send: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radii.sm, backgroundColor: colors.accent },
    sendOff: { opacity: 0.4 },
    inputSending: { color: colors.muted },
    receipt: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: space.x4 + 32 + space.x3, paddingRight: space.x4, paddingTop: 4, paddingBottom: space.x2 },
    receiptFaces: { flexDirection: "row" },
    receiptFaceBehind: { marginLeft: -5, borderRadius: 999, borderWidth: 1.5, borderColor: colors.pageSurface },
    problem: { color: colors.warnText },
    usage: { paddingHorizontal: space.x2, paddingVertical: 1, borderRadius: radii.pill, backgroundColor: colors.chrome },
    usageWord: { color: colors.text, fontWeight: "600" },
    usageMissing: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.line },
    usageMissingWord: { color: colors.warnText },
    weekUsed: { alignItems: "flex-end" },
    weekUsedNumber: { color: colors.text, fontWeight: "700", fontSize: pointerType.body },
  });

/**
 * Under a message: who had read it last, by face and name, and when the newest of them did; or, under the reader's own
 * newest word, that nobody has yet (`receipts.ts`, the boards Dev approved on 2026-11-26). Read as one sentence.
 */
function ReadReceipt({ receipt, faceOf }: { receipt: Receipt | "unread" | undefined; faceOf: FaceOf }) {
  const styles = useThemedStyles(makeStyles);
  if (receipt === undefined) return null;
  if (receipt === "unread") {
    return (
      <View style={styles.receipt} accessible accessibilityLabel="Not read yet" testID="mail-not-read">
        <Text variant="treeMeta" style={styles.muted}>
          Not read yet
        </Text>
      </View>
    );
  }
  const words = readByWords(receipt.readers);
  const time = clockLabel(new Date(receipt.at).toISOString());
  return (
    <View style={styles.receipt} accessible accessibilityLabel={`${words}, ${time}`} testID="mail-read">
      <View style={styles.receiptFaces} aria-hidden>
        {receipt.readers.slice(0, 3).map((reader, at) => (
          <View key={`${reader.label}|${at}`} style={at === 0 ? undefined : styles.receiptFaceBehind}>
            <OwnerFace face={faceOf(reader.face.name, reader.face.app)} size={16} />
          </View>
        ))}
      </View>
      <Text variant="treeMeta" style={styles.muted}>{`${words} · ${time}`}</Text>
    </View>
  );
}
