/**
 * One bot beside the Bots view: who it is and whose, what it did through Context, the areas it works in with its cap
 * on each, the routines of those areas, its mail, and a box to write to it (the owner, 2026-11-25, approving the
 * prototype). The box is mail, said so on it: a bot answers when it answers, and its thinking stays in its own app.
 *
 * Only its person changes where it works and its caps (the owner, 2026-11-25: "only they can assign their bots to
 * areas, adjust usage caps"); everyone else sees them. Refresh asks the bot, by mail, to send its name and logo again
 * (the owner's comment on the prototype: "should be a button to refresh the bot or something, have it update its
 * image and name if its changed"); Context never fetches a picture itself.
 */

import { worksInLine } from "@context/shared/src/areaRoutines.cjs";
import { botLabel } from "@context/shared/src/areaBots.cjs";
import { useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { agoLabel, timeLabel } from "../../mail/model";
import { useMailRoute } from "../../../mailPage/MailRouteContext";
import type { ListNote } from "../../listBlock/model";
import type { PropertyChanges } from "../useFolderPage";
import { OwnerFace, type Face } from "../Glyphs";
import { firstMailNote, type Thread } from "./areaMail";
import { botMailNote, mailOfBot, routinesOfBot, type Bot, type Conversation } from "./bots";
import { BotSetup } from "./BotSetup";
import { HealthWord, useBotHealth } from "./botHealth";
import { BotHelpers } from "./BotHelpers";
import { helpersOf } from "./botHelpers";
import { helperOfBot, helperParts, helperWords } from "../../../faces/helperName";
import { noteStarted, refreshBot, refreshedThisSession, refreshesVersion, startedMail, subscribeRefreshes } from "./refreshBot";

export interface BotPanelProps {
  bot: Bot;
  root: string;
  notes: readonly ListNote[];
  conversations: readonly Conversation[];
  threads: ReadonlyMap<string, Thread>;
  width: number;
  canEdit: boolean;
  me?: string;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  create?: (path: string, text: string) => Promise<unknown>;
  /** Reads a note and saves it back with the version read: how Refresh adds a line to mail already there. */
  io?: { read(path: string): Promise<{ text: string; etag?: string }>; write(path: string, text: string, expectedEtag?: string): Promise<unknown> };
  /** The workspace's `@handle`, named in what Refresh asks. */
  workspace?: string;
  /** The workspace's id, for its saved webhooks in Setup; absent in a fixture. */
  workspaceId?: string;
  chooseMany: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
  open: (path: string) => void;
  onClose: () => void;
}

type Tab = "activity" | "works" | "routines" | "mail";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "works", label: "Works in" },
  { id: "routines", label: "Routines" },
  { id: "mail", label: "Mail" },
];

export function BotPanel({ bot, root, notes, conversations, threads, width, canEdit, me, faceOf, label, create, io, workspace, workspaceId, chooseMany, open, onClose }: BotPanelProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [tab, setTab] = useState<Tab>("activity");
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const mail = mailOfBot(bot, conversations);
  // Its health, from its webhook's last call or its last check-in, and its routines' answers (`botHealth.tsx`).
  const health = useBotHealth(bot.name, bot.card.reach);
  const routines = routinesOfBot(bot, root, notes);
  // Its helpers: the sessions it started for deep work, each named "<helper> via <bot>" (`botHelpers.ts`).
  const helpers = helpersOf(bot, notes);
  // A mail name that is one of this bot's helpers, named as it is shown ("Claude via Grok Bot"), else null.
  const helperName = (name: string | null | undefined) => (helperOfBot(helperParts(name), bot.slug) ? helperWords(name, bot.name) : null);
  const mine = me === undefined ? null : botMailNote(bot, me);
  const hasMine = mine !== null && (notes.some((note) => note.path === mine) || sent === mine || startedMail(mine));
  const canWrite = canEdit && create !== undefined && me !== undefined && mine !== null;
  const editsCaps = canEdit && bot.mine;
  // A conversation opens in Agent Mail where the console has it, else as its note (Dev2, 2026-11-26).
  const mailRoute = useMailRoute();
  const openMail = (path: string) => (mailRoute === undefined ? open(path) : mailRoute.openThread(path));

  // What the bot itself said, newest first: its activity through Context.
  const activity = mail
    .map((each) => ({ each, last: threads.get(each.path)?.last ?? null }))
    .filter(({ last }) => last !== null)
    .sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? ""));

  const send = async (text: string) => {
    if (!canWrite || mine === null || me === undefined || create === undefined) return;
    if (hasMine) return openMail(mine);
    const note = firstMailNote(bot.name, me, text);
    if ("error" in note) return setProblem(note.error);
    try {
      await create(mine, note.text);
      setProblem(null);
      setSent(mine);
    } catch {
      setProblem("That didn't send. Try again.");
    }
  };

  // Refresh mails the bot its setup again and stays here (Dev, 2026-11-26: "clicking on refresh here keeps you on
  // the page"): a line added to the reader's mail with it, or that mail started. It can go again any time, and says
  // when it last went (Dev, 2026-11-26: "show the last time it was refreshed, and also allow it to send more than once").
  // When it last went is this bot's own: what this session sent it, else the newest Refresh in its mail (Dev2,
  // 2026-11-27: refreshing one bot showed the others as refreshed too, from one time kept for the whole panel).
  useSyncExternalStore(subscribeRefreshes, refreshesVersion, refreshesVersion);
  const [refreshing, setRefreshing] = useState(false);
  const lastRefreshed = [refreshedThisSession(bot.slug) ?? null, ...mail.map((each) => threads.get(each.path)?.refreshedAt ?? null)]
    .filter((at): at is string => typeof at === "string" && !Number.isNaN(Date.parse(at)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const refresh = async () => {
    if (refreshing || !canWrite || mine === null || me === undefined || create === undefined) return;
    if (hasMine && io === undefined) return openMail(mine);
    setRefreshing(true);
    try {
      const sentNow = await refreshBot(bot, { me, ...(workspace === undefined ? {} : { workspace }), exists: hasMine, create, ...(io === undefined ? {} : { io }) });
      if ("error" in sentNow) return setProblem(sentNow.error);
      if (sentNow.started) {
        noteStarted(sentNow.path);
        setSent(sentNow.path);
      }
      setProblem(null);
    } finally {
      setRefreshing(false);
    }
  };

  const setCap = async (folder: string, raw: string) => {
    const cap = raw.trim() === "" ? null : Number(raw.replace("%", "").trim());
    if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 100)) return setProblem("A cap is a whole percent from 0 to 100, or empty for none.");
    const lines = bot.areas.map((area) => worksInLine({ area: area.folder, cap: area.folder === folder ? cap : area.cap }));
    setProblem(await chooseMany(bot.card.path, [["works_in", lines]], false));
  };

  return (
    <View style={[styles.panel, { width }]} testID="bot-panel">
      <View style={styles.head}>
        <OwnerFace face={faceOf(bot.name)} size={36} />
        <View style={styles.headText}>
          <Text variant="tree" style={styles.title} numberOfLines={1}>
            {bot.name}
          </Text>
          <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
            {`${botLabel(bot.card.bot || "grok")}${bot.whose ? ` · ${bot.whose}'s` : ""}`}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityLabel="Close" style={styles.iconButton} testID="bot-panel-close">
          <Icon name="close" size={14} color={colors.muted} />
        </Pressable>
      </View>
      {/* How it is doing, first, for everyone who can see it (Dev, 2026-11-27: "see the health of each bot at a glance,
          even if I dont own the bot"). */}
      {health === undefined ? null : (
        <View style={styles.health} testID="bot-panel-health">
          <HealthWord health={health} strong />
          <Text variant="treeMeta" style={styles.healthWhy}>{health.why}</Text>
          {health.routines === null ? null : <Text variant="treeMeta" style={styles.healthWhy}>{health.routines}</Text>}
        </View>
      )}

      {/* What it has working for it now, under how it is doing; absent for a bot that has never had a helper. */}
      <BotHelpers helpers={helpers} botFace={faceOf(bot.name)} now={Date.now()} open={open} />

      <View style={styles.lockRow}>
        <Text variant="treeMeta" style={styles.lock} testID="bot-panel-whose">
          {bot.mine ? "Yours: only you change its setup, where it works and its caps." : `Only ${bot.whose || "its person"} changes its setup, where it works and its caps.`}
        </Text>
        {/* Refresh is mail to the bot: with no webhook and no check-ins nothing would reach it. */}
        {canWrite && health?.state !== "not set up" ? (
          <View style={styles.refreshBox}>
            <Pressable onPress={() => void refresh()} disabled={refreshing} style={[styles.smallButton, refreshing && styles.dim]} accessibilityLabel={`Ask ${bot.name} to refresh its setup, name and logo`} testID="bot-panel-refresh">
              <Text variant="treeMeta" style={styles.smallWord}>
                {refreshing ? "Sending…" : "Refresh"}
              </Text>
            </Pressable>
            {lastRefreshed !== undefined ? (
              <Text variant="treeMeta" style={styles.muted} numberOfLines={1} testID="bot-panel-refreshed">
                {`Refreshed ${timeLabel(lastRefreshed)}`}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Setup is the bot's, so it lives here and not on each area it holds (Dev, 2026-11-27). */}
      <BotSetup bot={bot} health={health} canEdit={canEdit} cardPath={bot.card.path} chooseMany={chooseMany} {...(workspace === undefined ? {} : { workspace })} {...(workspaceId === undefined ? {} : { workspaceId })} />

      <View style={styles.tabs} role="tablist">
        {TABS.map((each) => (
          <Pressable key={each.id} role="tab" aria-selected={tab === each.id} onPress={() => setTab(each.id)} style={[styles.tab, tab === each.id && styles.tabOn]} testID={`bot-panel-tab-${each.id}`}>
            <Text variant="treeMeta" style={tab === each.id ? styles.tabWordOn : styles.muted}>
              {each.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.body}>
        {tab === "activity" ? (
          activity.length === 0 ? (
            <Text variant="treeMeta" style={styles.muted}>Nothing yet. What it writes in Context mail shows here.</Text>
          ) : (
            activity.map(({ each, last }) => (
              <Pressable key={each.path} onPress={() => openMail(each.path)} style={styles.line}>
                <Text variant="treeMeta" style={styles.when}>
                  {last ? agoLabel(last.at) : ""}
                </Text>
                <View style={styles.lineText}>
                  <Text variant="tree" numberOfLines={1}>{`${last?.from === bot.slug || last?.from === bot.name.toLowerCase().replace(/\s+/g, "-") ? "Wrote" : helperName(last?.from) !== null ? `${helperName(last?.from)} wrote` : "Got mail"} in ${each.placeTitle}`}</Text>
                  <Text variant="treeMeta" style={styles.muted} numberOfLines={2}>
                    {last?.text ?? ""}
                  </Text>
                </View>
              </Pressable>
            ))
          )
        ) : null}

        {tab === "works" ? (
          <>
            {bot.areas.length === 0 ? <Text variant="treeMeta" style={styles.muted}>Holds no area yet. Make it an area's owner or delegate from the area's panel.</Text> : null}
            {bot.areas.map((area) => (
              <View key={area.folder} style={styles.line} testID={`bot-panel-area-${area.folder}`}>
                <View style={styles.lineText}>
                  <Text variant="tree" numberOfLines={1}>{area.title}</Text>
                  <Text variant="treeMeta" style={styles.muted}>
                    {area.role === "owner" ? "Owns it" : "Delegate for its person owner"}
                  </Text>
                </View>
                {editsCaps ? (
                  <CapField value={area.cap} label={`Weekly cap for ${area.title}`} onCommit={(raw) => void setCap(area.folder, raw)} />
                ) : (
                  <Text variant="treeMeta" style={styles.muted}>{area.cap === null ? "no cap" : `${area.cap}%`}</Text>
                )}
              </View>
            ))}
            <Text variant="treeMeta" style={styles.muted}>
              A cap is the share of the bot's week an area may spend. The bot says what each answer used; once an area's share is spent, its routines and mail wait until Monday.
            </Text>
          </>
        ) : null}

        {tab === "routines" ? (
          routines.length === 0 ? (
            <Text variant="treeMeta" style={styles.muted}>No routines. A routine is a note in an area's routines/ folder; Context runs it on time and sends it here.</Text>
          ) : (
            routines.map((routine) => (
              <Pressable key={routine.path} onPress={() => open(routine.path)} style={styles.line}>
                <View style={styles.lineText}>
                  <Text variant="tree" numberOfLines={1}>{routine.name}</Text>
                  <Text variant="treeMeta" style={styles.muted}>{`${routine.how} · ${routine.area}`}</Text>
                </View>
              </Pressable>
            ))
          )
        ) : null}

        {tab === "mail" ? (
          mail.length === 0 ? (
            <Text variant="treeMeta" style={styles.muted}>No mail yet.</Text>
          ) : (
            mail.map((each) => {
              const last = threads.get(each.path)?.last;
              const helper = each.mine ? null : helperName(each.sender);
              return (
                <Pressable key={each.path} onPress={() => openMail(each.path)} style={styles.line} testID={`bot-panel-mail-${each.path}`}>
                  <OwnerFace face={each.mine ? { kind: "person", name: "You" } : helper !== null ? { kind: "helper", helper: helper.split(" ")[0]!, via: faceOf(bot.name) } : faceOf(each.sender)} size={18} />
                  <View style={styles.lineText}>
                    <Text variant="tree" numberOfLines={1}>{`${each.mine ? "You" : (helper ?? each.sender)} ↔ ${each.with === null ? "nobody" : label(each.with)}`}</Text>
                    <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
                      {last ? `${helperName(last.from) ?? last.from}: ${last.text}` : each.placeTitle}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )
        ) : null}
      </View>

      {canWrite && mine !== null ? <Composer bot={bot} hasMine={hasMine} reach={health?.via ?? "none"} onSend={send} /> : null}
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.problem}>{problem}</Text>}
      {sent === null ? null : <Text variant="treeMeta" style={styles.muted} testID="bot-panel-sent">Sent as mail. Open the conversation later to read its answer.</Text>}
    </View>
  );
}

function CapField({ value, label, onCommit }: { value: number | null; label: string; onCommit: (raw: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <View style={styles.cap}>
      <TextInput value={text} onChangeText={setText} onBlur={() => onCommit(text)} onSubmitEditing={() => onCommit(text)} accessibilityLabel={label} placeholder="none" inputMode="numeric" style={[styles.capInput, fieldFont]} testID={`bot-panel-cap-${label}`} />
      <Text variant="treeMeta" style={styles.muted}>%</Text>
    </View>
  );
}

/** The box to write to the bot: mail, and it says so. */
function Composer({ bot, hasMine, reach, onSend }: { bot: Bot; hasMine: boolean; reach: "webhook" | "check" | "none"; onSend: (text: string) => Promise<void> }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const [text, setText] = useState("");
  const go = () => {
    if (!hasMine && text.trim() === "") return;
    void onSend(text).then(() => setText(""));
  };
  return (
    <View style={styles.composer} testID="bot-panel-composer">
      {hasMine ? (
        <Pressable onPress={go} style={styles.smallButton} testID="bot-panel-open-mail">
          <Text variant="treeMeta" style={styles.smallWord}>{`Open your mail with ${bot.name}`}</Text>
        </Pressable>
      ) : (
        <View style={styles.write}>
          <TextInput value={text} onChangeText={setText} onSubmitEditing={go} accessibilityLabel={`Mail ${bot.name}`} placeholder={`Mail ${bot.name}…`} placeholderTextColor={colors.muted} style={[styles.input, fieldFont]} testID="bot-panel-input" />
          <Pressable role="button" onPress={go} style={styles.send} testID="bot-panel-send">
            <Text variant="treeMeta" style={styles.sendWord}>Send</Text>
          </Pressable>
        </View>
      )}
      <Text variant="treeMeta" style={styles.muted} testID="bot-panel-mail-note">
        {`Mail, not a chat. ${reach === "webhook" ? "Its webhook is told now" : reach === "check" ? "It sees this when it next checks in" : "It gets this once it is set up"}, and it answers in the same note when it answers. Its thinking stays in its own app.`}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { gap: space.x3 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    headText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    title: { fontSize: pointerType.lede, fontWeight: "600" },
    muted: { color: colors.muted },
    warn: { color: colors.warnText },
    problem: { color: colors.critText },
    iconButton: { padding: space.x1, borderRadius: radii.sm },
    health: { gap: 2, padding: space.x3, borderRadius: radii.card, backgroundColor: colors.chipFill },
    healthWhy: { color: colors.text2, marginLeft: 14 },
    lockRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingBottom: space.x3, borderBottomWidth: 1, borderBottomColor: colors.line },
    lock: { flexGrow: 1, flexShrink: 1, color: colors.muted },
    refreshBox: { alignItems: "flex-end", gap: 2, flexShrink: 0 },
    dim: { opacity: 0.6 },
    smallButton: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    smallWord: { color: colors.text, fontWeight: "600" },
    tabs: { flexDirection: "row", gap: space.x1 },
    tab: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.pill },
    tabOn: { backgroundColor: colors.chipFill },
    tabWordOn: { color: colors.text, fontWeight: "600" },
    body: { gap: space.x2 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 34 },
    lineText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    when: { color: colors.muted, width: 56 },
    cap: { flexDirection: "row", alignItems: "center", gap: 2 },
    capInput: { width: 48, textAlign: "right", fontFamily: fonts.body, color: colors.text, paddingVertical: 2, paddingHorizontal: 6, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    composer: { gap: space.x1, paddingTop: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
    write: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    input: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontFamily: fonts.body, color: colors.text, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    send: { paddingVertical: 4, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    sendWord: { color: colors.surface, fontWeight: "600" },
  });
