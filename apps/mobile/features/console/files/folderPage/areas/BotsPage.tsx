/**
 * The Areas folder's Bots and Mail views (the owner, 2026-11-25, approving the prototype: "make it clear in the UI
 * that its not a chat, and that its mail, because we wont be able to see into its thinking, stream, etc").
 *
 * - **Bots**: every bot card the reader can see, theirs first, each with the areas it holds and its caps there. A
 *   press shows the bot in the side panel (`BotPanel.tsx`).
 * - **Mail**: every mail note under the Areas folder, with who is on each side and its newest line, filtered to bot
 *   to bot or the reader's own. A press opens the note, whose own mail box answers in place.
 *
 * Everything is read from the notes the page already holds (`bots.ts`) and each mail note's text at the reader's
 * clearance; nothing here is a store of its own.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { agoLabel } from "../../mail/model";
import type { ListNote } from "../../listBlock/model";
import type { PropertyChanges } from "../useFolderPage";
import { OwnerFace, type Face } from "../Glyphs";
import { threadOf, type Thread } from "./areaMail";
import { botsOf, conversationsOf, type Bot, type Conversation } from "./bots";
import { BotPanel } from "./BotPanel";
import { panelSlot, PanelSlotView } from "./botPanelSlot";
import { botLabel } from "@context/shared/src/areaBots.cjs";

export interface BotsPageProps {
  view: "bots" | "talks";
  root: string;
  notes: readonly ListNote[];
  compact: boolean;
  canEdit: boolean;
  /** The reader's own `@handle`. */
  me?: string;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  /** A note's text at the reader's clearance. */
  read?: (path: string) => Promise<{ text: string; encrypted: boolean } | null>;
  /** Writes a new note; absent where the reader may not write. */
  create?: (path: string, text: string) => Promise<unknown>;
  chooseMany: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
  open: (path: string) => void;
  onPanel?: (panel: ((width: number) => React.ReactNode) | null) => void;
}

/** Each note's count and newest line, read once per path list. */
export function useThreads(paths: readonly string[], read: BotsPageProps["read"]): ReadonlyMap<string, Thread> {
  const [threads, setThreads] = useState<ReadonlyMap<string, Thread>>(new Map());
  const key = paths.join("\n");
  useEffect(() => {
    if (read === undefined || paths.length === 0) return;
    let live = true;
    void Promise.all(paths.slice(0, 60).map(async (path) => [path, await read(path).catch(() => null)] as const)).then((found) => {
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

type Filter = "all" | "bots" | "mine";
const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bots", label: "Bot to bot" },
  { id: "mine", label: "With me" },
];

export function BotsPage(props: BotsPageProps) {
  const { view, root, notes, compact, canEdit, me, faceOf, label, read, create, chooseMany, open, onPanel } = props;
  const styles = useThemedStyles(makeStyles);
  const bots = useMemo(() => botsOf(root, notes, me), [root, notes, me]);
  const conversations = useMemo(() => conversationsOf(root, notes, bots, me), [root, notes, bots, me]);
  const threads = useThreads(
    conversations.map((each) => each.path),
    read,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const bot = selected === null ? undefined : bots.find((each) => each.name === selected);

  // The bot shows in the side panel where the page has one; on a phone it takes the page's place.
  const slot = useRef(panelSlot()).current;
  const panel =
    bot === undefined
      ? null
      : { bot, root, notes, conversations, threads, canEdit, ...(me === undefined ? {} : { me }), faceOf, label, ...(create === undefined ? {} : { create }), chooseMany, open, onClose: () => setSelected(null) };
  useEffect(() => slot.set(panel));
  const panelOpen = bot !== undefined && onPanel !== undefined;
  useEffect(() => {
    onPanel?.(panelOpen ? (width: number) => <PanelSlotView slot={slot} width={width} /> : null);
  }, [onPanel, panelOpen, slot]);
  useEffect(() => () => onPanel?.(null), [onPanel]);

  if (panel !== null && onPanel === undefined) return <BotPanel {...panel} width={compact ? 360 : 420} />;

  if (view === "talks") {
    const shown = conversations.filter((each) => (filter === "all" ? true : filter === "bots" ? each.botToBot : each.mine));
    const ordered = [...shown].sort((a, b) => (threads.get(b.path)?.last?.at ?? "").localeCompare(threads.get(a.path)?.last?.at ?? ""));
    return (
      <View style={styles.page} testID="areas-mail-view">
        <View style={styles.headRow}>
          <Text variant="treeMeta" style={styles.muted}>
            Mail between people and bots in every area. A bot answers when it answers; what it thinks in between stays in its own app.
          </Text>
        </View>
        <View style={styles.filters} role="tablist">
          {FILTERS.map((each) => (
            <Pressable key={each.id} role="tab" aria-selected={filter === each.id} onPress={() => setFilter(each.id)} style={[styles.filter, filter === each.id && styles.filterOn]} testID={`areas-mail-filter-${each.id}`}>
              <Text variant="treeMeta" style={filter === each.id ? styles.filterWordOn : styles.muted}>
                {each.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {ordered.length === 0 ? <Text variant="treeMeta" style={styles.muted}>No mail here yet.</Text> : null}
        {ordered.map((each) => (
          <MailRow key={each.path} conversation={each} thread={threads.get(each.path)} faceOf={faceOf} label={label} onPress={() => open(each.path)} />
        ))}
      </View>
    );
  }

  const groups = new Map<string, Bot[]>();
  for (const each of bots) {
    const key = each.mine ? "mine" : each.whose || "nobody";
    groups.set(key, [...(groups.get(key) ?? []), each]);
  }
  return (
    <View style={styles.page} testID="areas-bots-view">
      {bots.length === 0 ? (
        <Text variant="treeMeta" style={styles.muted}>
          No bots yet. Add one from an area's Owner menu: pick "+ Add a Grok bot…".
        </Text>
      ) : null}
      {[...groups].map(([key, list]) => (
        <View key={key} style={styles.group}>
          <Text variant="treeMeta" style={styles.groupTitle}>
            {key === "mine" ? `Yours${me ? ` · ${me}` : ""}` : key === "nobody" ? "Nobody's yet" : `${key}'s · only ${key} can change them`}
          </Text>
          {list.map((each) => (
            <BotRow key={each.name} bot={each} face={faceOf(each.name)} selected={each.name === selected} onPress={() => setSelected(each.name === selected ? null : each.name)} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** "20% of its week here", "Caps: 30% in 2 areas", or "No caps". */
export function capWords(bot: Bot): string {
  const capped = bot.areas.filter((area) => area.cap !== null);
  if (capped.length === 0) return "No caps";
  const total = capped.reduce((sum, area) => sum + (area.cap ?? 0), 0);
  return capped.length === 1 ? `${total}% of its week here` : `${total}% of its week over ${capped.length} areas`;
}

function BotRow({ bot, face, selected, onPress }: { bot: Bot; face: Face; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const where = bot.areas.length === 0 ? "Holds no area yet" : bot.areas.map((area) => area.title).join(", ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`${bot.name}, ${botLabel(bot.card.bot || "grok")}`}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, (hovered || selected) && styles.rowOn]}
      testID={`areas-bot-${bot.name}`}
    >
      <OwnerFace face={face} size={28} />
      <View style={styles.rowText}>
        <Text variant="tree" numberOfLines={1} style={styles.name}>
          {bot.name}
        </Text>
        <Text variant="treeMeta" numberOfLines={1} style={styles.muted}>
          {`${botLabel(bot.card.bot || "grok")} · ${bot.card.reach === "webhook" ? "webhook" : "checks its mail"} · ${where}`}
        </Text>
      </View>
      <Text variant="treeMeta" style={styles.muted}>
        {capWords(bot)}
      </Text>
    </Pressable>
  );
}

function MailRow({ conversation, thread, faceOf, label, onPress }: { conversation: Conversation; thread: Thread | undefined; faceOf: (owner: string | null) => Face; label: (owner: string) => string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const from = conversation.mine ? "You" : conversation.sender;
  const to = conversation.with === null ? "nobody yet" : label(conversation.with);
  return (
    <Pressable onPress={onPress} role="link" style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, hovered && styles.rowOn]} testID={`areas-mail-${conversation.path}`}>
      <View style={styles.pair}>
        <OwnerFace face={conversation.mine ? { kind: "person", name: from } : faceOf(conversation.sender)} size={20} />
        <OwnerFace face={faceOf(conversation.with)} size={20} />
      </View>
      <View style={styles.rowText}>
        <Text variant="tree" numberOfLines={1} style={styles.name}>
          {`${from} ↔ ${to}`}
        </Text>
        <Text variant="treeMeta" numberOfLines={1} style={{ color: colors.muted }}>
          {thread?.last ? `${thread.last.from}: ${thread.last.text}` : conversation.placeTitle}
        </Text>
      </View>
      <Text variant="treeMeta" style={styles.muted}>
        {`${conversation.placeTitle}${thread?.last ? ` · ${agoLabel(thread.last.at)}` : ""}`}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x2 },
    headRow: { paddingBottom: space.x1 },
    muted: { color: colors.muted },
    group: { gap: 2, marginTop: space.x2 },
    groupTitle: { color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, fontSize: pointerType.meta, marginBottom: space.x1 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 48, paddingHorizontal: space.x2, marginHorizontal: -space.x2, borderRadius: radii.sm },
    rowOn: { backgroundColor: colors.chipFill },
    rowText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    name: { fontWeight: "600" },
    pair: { flexDirection: "row", gap: 2 },
    filters: { flexDirection: "row", gap: space.x1, marginBottom: space.x1 },
    filter: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.line },
    filterOn: { backgroundColor: colors.text, borderColor: colors.text },
    filterWordOn: { color: colors.surface, fontWeight: "600" },
  });
