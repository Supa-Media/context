/**
 * The area panel's Mail: one row per conversation in the area's `mail/`
 * folder (who it is with, how many messages, the newest), and a box to start
 * your own with whoever holds the area (the owner, 2026-11-25: "when people
 * look in areas, they are able to sort of dialogue with that grokbot, like
 * send it mail and it be able to send mail back"). A conversation opens as its
 * note, whose own mail box answers in place.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { agoLabel } from "../../mail/model";
import { OwnerFace, type Face } from "../Glyphs";
import { firstMailNote, senderNote, senderOf, threadOf, type Thread } from "./areaMail";

/** What the panel needs to show and start an area's mail. */
export interface PanelMailTools {
  /** The area's mail notes (`mailNotesOf`). */
  notesIn: (area: string) => readonly string[];
  /** A note's text at the reader's clearance; absent where nothing can be read. */
  read?: (path: string) => Promise<{ text: string; encrypted: boolean } | null>;
  /** Writes a new note, refused when one is there; absent where the reader may not write. */
  create?: (path: string, text: string) => Promise<unknown>;
  /** The reader's own `@handle`, who a new conversation is from. */
  me?: string;
  /** Opens a note. */
  open: (path: string) => void;
  /** A sender's face, for a bot (its logo, where its card names one); null draws the mail mark. */
  faceOf?: (sender: string) => Face | null;
}

/** Each conversation's count and newest message, read once per path and text change. */
function useThreads(paths: readonly string[], read: PanelMailTools["read"]): ReadonlyMap<string, Thread> {
  const [threads, setThreads] = useState<ReadonlyMap<string, Thread>>(new Map());
  const key = paths.join("\n");
  useEffect(() => {
    if (read === undefined || paths.length === 0) return;
    let live = true;
    void Promise.all(paths.map(async (path) => [path, await read(path).catch(() => null)] as const)).then((found) => {
      if (!live) return;
      const next = new Map<string, Thread>();
      for (const [path, body] of found) if (body !== null && !body.encrypted) next.set(path, threadOf(body.text));
      setThreads(next);
    });
    return () => {
      live = false;
    };
    // `key` stands for `paths`, whose array is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read]);
  return threads;
}

export function PanelMail({ area, holder, label, tools }: { area: string; holder: string | null; label: (owner: string) => string; tools: PanelMailTools }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const paths = tools.notesIn(area);
  const threads = useThreads(paths, tools.read);
  const mine = tools.me === undefined ? null : senderNote(area, tools.me);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const fieldFont = useFieldFont(pointerType.ui);
  const hasMine = mine !== null && (paths.includes(mine) || sent === mine);
  const canStart = holder !== null && mine !== null && tools.create !== undefined && tools.me !== undefined && !hasMine;

  const start = async () => {
    if (!canStart || holder === null || mine === null || tools.me === undefined || tools.create === undefined) return;
    const note = firstMailNote(label(holder), tools.me, text);
    if ("error" in note) return setProblem(note.error);
    try {
      await tools.create(mine, note.text);
      setText("");
      setProblem(null);
      setSent(mine);
    } catch {
      setProblem("That didn't send. Try again.");
    }
  };

  return (
    <View style={styles.mail} testID="area-panel-mail">
      {paths.length === 0 && sent === null ? <Text variant="treeMeta" style={styles.muted}>No mail yet.</Text> : null}
      {[...paths, ...(sent !== null && !paths.includes(sent) ? [sent] : [])].map((path) => {
        const thread = threads.get(path);
        const who = senderOf(path);
        const face = path === mine ? null : (tools.faceOf?.(who) ?? null);
        return (
          <Pressable
            key={path}
            onPress={() => tools.open(path)}
            role="link"
            accessibilityLabel={`Mail from ${who}`}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.thread, hovered && styles.hover]}
            testID={`area-panel-mail-${who}`}
          >
            {face === null ? <Icon name="mail" size={14} color={colors.muted} /> : <OwnerFace face={face} size={16} />}
            <View style={styles.threadText}>
              <Text variant="tree" numberOfLines={1}>{path === mine ? `You ↔ ${holder === null ? "the owner" : label(holder)}` : who}</Text>
              {thread?.last ? (
                <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>{`${thread.last.from}: ${thread.last.text}`}</Text>
              ) : null}
            </View>
            {thread?.last ? <Text variant="treeMeta" style={styles.muted}>{agoLabel(thread.last.at)}</Text> : null}
          </Pressable>
        );
      })}
      {canStart && holder !== null ? (
        <View style={styles.write}>
          <TextInput
            value={text}
            onChangeText={(next) => {
              setText(next);
              setProblem(null);
            }}
            onSubmitEditing={() => void start()}
            accessibilityLabel={`Write to ${label(holder)}`}
            placeholder={`Write to ${label(holder)}…`}
            placeholderTextColor={colors.muted}
            style={[styles.input, fieldFont]}
            testID="area-panel-mail-input"
          />
          <Pressable role="button" onPress={() => void start()} style={styles.send} testID="area-panel-mail-send">
            <Text variant="treeMeta" style={styles.sendWord}>Send</Text>
          </Pressable>
        </View>
      ) : null}
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.problem}>{problem}</Text>}
      {sent === null ? null : <Text variant="treeMeta" style={styles.muted} testID="area-panel-mail-sent">Sent. Open the conversation to read the answer and reply.</Text>}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    mail: { gap: space.x1 },
    muted: { color: colors.muted },
    thread: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 34, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    hover: { backgroundColor: colors.chipFill },
    threadText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    write: { flexDirection: "row", alignItems: "center", gap: space.x2, marginTop: space.x1 },
    input: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontFamily: fonts.body, color: colors.text, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    send: { paddingVertical: 4, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    sendWord: { color: colors.surface, fontWeight: "600" },
    problem: { color: colors.critText },
  });
