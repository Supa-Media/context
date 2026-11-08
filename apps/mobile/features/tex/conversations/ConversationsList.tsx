import { Fragment, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { More, SectionHead, T, useNow } from "../page/TexPageParts";
import { ago } from "../page/texPageFormat";
import { dayKey, dayTitle, timeOf } from "../history/historyLines";
import type { Read, TexPageSource } from "../page/texPageSource";
import type { Conversation, ConversationDetail } from "../page/texPageTypes";

/**
 * A chat's conversations (Dev2, 2026-11-07: "mock a special UI for the threads
 * ... in the Tex Hub and also when you open the Tex folder", built from the
 * approved canvas): open ones first, then finished, each newest first, as the
 * classifier left them (`apps/mcp/src/agent/conversationThreads.js`). A row
 * opens in place to its texts and Tex's answers, drawn as the history file
 * draws a line: time, who, words. Read from the gateway each time it is shown;
 * nothing here keeps a copy.
 *
 * The same list is the Tex page's Conversations page and the conversations
 * file in a Tex folder (`ConversationsFileView`); the Tex Hub shows its first
 * few open ones (`ConversationsPeek`).
 */

/** Finished conversations drawn before "Show all". */
const FINISHED_SHOWN = 20;

type Loaded = { kind: "loading" } | { kind: "ok"; list: Conversation[] } | { kind: "notYours" } | { kind: "failed" };

/** The chat's conversations, read once when shown and again when `changes` moves. */
export function useConversations(source: TexPageSource, chat: string, changes = 0): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    if (typeof source.conversations !== "function") {
      setLoaded({ kind: "ok", list: [] });
      return;
    }
    void source.conversations(chat).then((read: Read<Conversation[]>) => {
      if (!live) return;
      setLoaded(read.kind === "ok" ? { kind: "ok", list: read.value } : read.kind === "notYours" ? { kind: "notYours" } : { kind: "failed" });
    });
    return () => {
      live = false;
    };
  }, [source, chat, changes]);
  return loaded;
}

export function ConversationsList({
  source,
  chat,
  group,
  phone,
  changes = 0,
  testID = "tex-conversations",
}: {
  source: TexPageSource;
  chat: string;
  /** A group chat names each person; a person's own chat says "You". */
  group: boolean;
  phone: boolean;
  changes?: number;
  testID?: string;
}) {
  const loaded = useConversations(source, chat, changes);
  const [open, setOpen] = useState<string | null>(null);
  const [allFinished, setAllFinished] = useState(false);
  if (loaded.kind === "loading") return <ActivityIndicator size="small" testID={`${testID}-wait`} />;
  if (loaded.kind !== "ok") {
    return (
      <T size={14} tone="muted" testID={`${testID}-failed`}>
        {loaded.kind === "notYours" ? "This chat's conversations open for the people in it, from their own Tex." : "Couldn't read the conversations just now."}
      </T>
    );
  }
  if (loaded.list.length === 0) {
    return (
      <T size={14} tone="muted" testID={`${testID}-empty`}>
        No conversations yet. Tex sorts each new text into one as it comes.
      </T>
    );
  }
  const opened = loaded.list.filter((c) => c.status === "open");
  const finished = loaded.list.filter((c) => c.status !== "open");
  const shownFinished = allFinished ? finished : finished.slice(0, FINISHED_SHOWN);
  const row = (c: Conversation) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      expanded={open === c.id}
      onToggle={() => setOpen((was) => (was === c.id ? null : c.id))}
      source={source}
      chat={chat}
      group={group}
      phone={phone}
    />
  );
  return (
    <View style={{ gap: 22 }} testID={testID}>
      {opened.length > 0 ? (
        <View>
          <SectionHead>{`Open · ${opened.length}`}</SectionHead>
          <ListTop>{opened.map(row)}</ListTop>
        </View>
      ) : null}
      {finished.length > 0 ? (
        <View>
          <SectionHead>{`Finished · ${finished.length}`}</SectionHead>
          <ListTop>{shownFinished.map(row)}</ListTop>
          {finished.length > shownFinished.length ? (
            <More onPress={() => setAllFinished(true)} testID={`${testID}-all-finished`}>
              {`Show all ${finished.length} finished`}
            </More>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ListTop({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.list}>{children}</View>;
}

/** `.li`: a conversation's title and where it stands; tapped, its lines below it. */
export function ConversationRow({
  conversation: c,
  expanded,
  onToggle,
  source,
  chat,
  group,
  phone,
}: {
  conversation: Conversation;
  expanded: boolean;
  onToggle: () => void;
  source: TexPageSource;
  chat: string;
  group: boolean;
  phone: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const now = useNow();
  return (
    <View style={styles.item}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${c.title}. ${c.description}`}
        onPress={onToggle}
        style={styles.li}
        testID={`tex-conversation-${c.id}`}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={14} weight="500">{`${expanded ? "▾" : "▸"} ${c.title}`}</T>
          {c.description ? (
            <T size={13} tone="muted">
              {c.description}
            </T>
          ) : null}
        </View>
        <View style={styles.right}>
          <T size={13} tone="text2" numberOfLines={1}>
            {ago(c.last, now)}
          </T>
          <T size={12} tone="muted" numberOfLines={1}>
            {`${c.texts} ${c.texts === 1 ? "text" : "texts"}`}
          </T>
        </View>
      </Pressable>
      {expanded ? <ConversationLines source={source} chat={chat} id={c.id} group={group} phone={phone} /> : null}
    </View>
  );
}

type Detail = { kind: "loading" } | { kind: "ok"; value: ConversationDetail } | { kind: "failed" };

function ConversationLines({ source, chat, id, group, phone }: { source: TexPageSource; chat: string; id: string; group: boolean; phone: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const now = new Date(useNow());
  const [detail, setDetail] = useState<Detail>({ kind: "loading" });
  const read = useCallback(async () => {
    if (typeof source.conversation !== "function") return { kind: "failed" } as const;
    return await source.conversation(chat, id);
  }, [source, chat, id]);
  useEffect(() => {
    let live = true;
    setDetail({ kind: "loading" });
    void read().then((r) => {
      if (live) setDetail(r.kind === "ok" ? { kind: "ok", value: r.value } : { kind: "failed" });
    });
    return () => {
      live = false;
    };
  }, [read]);
  if (detail.kind === "loading") return <ActivityIndicator size="small" style={styles.wait} testID={`tex-conversation-${id}-wait`} />;
  if (detail.kind === "failed") {
    return (
      <T size={13} tone="muted" style={styles.lines}>
        Couldn't read this conversation just now.
      </T>
    );
  }
  const { lines, more } = detail.value;
  let lastDay = "";
  return (
    <View style={styles.lines} testID={`tex-conversation-${id}-lines`}>
      {more ? (
        <T size={13} tone="muted" style={{ paddingVertical: 4 }}>
          Older texts in this conversation are in History.
        </T>
      ) : null}
      {lines.length === 0 ? (
        <T size={13} tone="muted" style={{ paddingVertical: 4 }}>
          Its texts are older than what's kept here; History has the whole chat.
        </T>
      ) : null}
      {lines.map((line) => {
        const key = dayKey(line.at);
        const newDay = key !== lastDay;
        lastDay = key;
        const who = line.who === "tex" ? "Tex" : group ? (line.name ?? "Someone") : "You";
        return (
          <Fragment key={line.id}>
            {newDay ? (
              <T size={13} weight="600" style={styles.day}>
                {dayTitle(key, now)}
              </T>
            ) : null}
            {phone ? (
              <View style={styles.stacked}>
                <View style={styles.whoTime}>
                  <T size={13} weight="600" tone={line.who === "tex" ? "accent" : "text"} numberOfLines={1}>
                    {who}
                  </T>
                  <T size={13} tone="muted">
                    {timeOf(line.at)}
                  </T>
                </View>
                <T size={15} line={1.45}>
                  {line.text}
                </T>
              </View>
            ) : (
              <View style={styles.line}>
                <T size={13} tone="muted" style={styles.time}>
                  {timeOf(line.at)}
                </T>
                <T size={13} weight="500" tone={line.who === "tex" ? "accent" : "text"} style={styles.who} numberOfLines={1}>
                  {who}
                </T>
                <T size={15} line={1.45} style={{ flex: 1, minWidth: 0 }}>
                  {line.text}
                </T>
              </View>
            )}
          </Fragment>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { borderTopWidth: 1, borderTopColor: colors.line },
    item: { borderBottomWidth: 1, borderBottomColor: colors.line },
    li: { flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 11 },
    right: { alignItems: "flex-end", gap: 2 },
    wait: { alignSelf: "flex-start", marginBottom: 12 },
    // The history file's quote rule: a conversation's lines sit under its row, a hairline to their left.
    lines: { borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 12, marginBottom: 12, marginLeft: 4 },
    day: { paddingTop: 8, paddingBottom: 2 },
    line: { flexDirection: "row", gap: 12, alignItems: "baseline", paddingVertical: 4 },
    time: { width: 72 },
    who: { width: 96 },
    stacked: { paddingVertical: 6, gap: 2 },
    whoTime: { flexDirection: "row", gap: 8, alignItems: "baseline" },
  });
