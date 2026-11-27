/**
 * A bot's setup, on its own page and panel rather than on each area it holds (Dev, 2026-11-27: "the setup options
 * should be in the bot page"): how it reaches Context, its webhook (host, header, who set it, Send a test, Replace, or
 * set by hand; `PanelBotHook.tsx`) and the one setup prompt. It reaches Context one of two ways, its card's `reach`:
 * a webhook Context calls, or checking in every 5 minutes (`reach: mail`), where `orient { check: true }` answers only
 * whether anything is new (Dev, 2026-11-27: "design it in a lightweight way where the MCP can just return wether it
 * has anything new in its inbox or not"). A saved webhook wins over the card.
 *
 * Who changes it: its person, or whoever may replace the saved webhook (`botHookList` `canReplace`: who set it, or the
 * workspace's owner). Everyone else sees what is saved, read-only. While it isn't working, its setup prompt is drawn
 * open, since pasting it again is the way back.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { writeClipboard } from "../../../../design/clipboard";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { appOf } from "@context/shared/src/botApps.cjs";
import { PromptBox, botSetupPrompt } from "./PanelBotFields";
import { BotHookFields } from "./PanelBotHook";
import type { Bot } from "./bots";
import { useBotHookRow, type BotHealth } from "./botHealth";
import type { PropertyChanges } from "../useFolderPage";

export interface BotSetupProps {
  bot: Bot;
  health: BotHealth | undefined;
  canEdit: boolean;
  /** The workspace's `@handle`, named in the prompt. */
  workspace?: string;
  /** The workspace's id, for its saved webhooks; absent in a fixture, where only the prompt is drawn. */
  workspaceId?: string;
  /** The bot's card's path, named in the prompt. */
  cardPath?: string;
  /** Writes the card's front matter, for its reach; absent where it can't be changed. */
  chooseMany?: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
}

type Way = "webhook" | "check";
const WAYS: readonly { id: Way; label: string }[] = [
  { id: "webhook", label: "Webhook" },
  { id: "check", label: "Checks in every 5 min" },
];

export function BotSetup({ bot, health, canEdit, workspace, workspaceId, cardPath, chooseMany }: BotSetupProps) {
  const styles = useThemedStyles(makeStyles);
  const row = useBotHookRow(bot.name);
  const mayChange = canEdit && (bot.mine || row?.canReplace === true);
  const [chosen, setChosen] = useState<Way | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const way: Way = row !== null && row !== undefined ? "webhook" : (chosen ?? (bot.card.reach === "mail" ? "check" : "webhook"));
  const choose = async (next: Way) => {
    if (chooseMany === undefined || next === way) return;
    setChosen(next);
    setProblem(await chooseMany(bot.card.path, [["reach", next === "check" ? "mail" : "webhook"]], false));
  };
  const prompt = botSetupPrompt(
    { ...bot.card, reach: way === "check" ? "mail" : "webhook" },
    bot.areas.map((area) => ({ folder: area.folder, title: area.title, modes: area.modes, ...(area.actsFor === undefined ? {} : { actsFor: area.actsFor }) })),
    workspace,
    cardPath,
  );
  const failing = health?.bad === true;
  const promptOpen = mayChange && (row === null || failing);
  const again = way === "check" ? (health?.state === "stopped checking" || health?.state === "not answering" ? `Paste it into ${bot.name} again. It sets its 5-minute check-in up again, on a timer that outlasts its chat.` : `Paste it into ${bot.name}. It connects Context and checks in every 5 minutes.`) : row === null ? `Paste it into ${bot.name}. It connects Context, asks you to sign in, and saves its webhook.` : `Paste it into ${bot.name}. It saves its webhook again and sends a test.`;

  const saved = row !== null && row !== undefined;
  const promptBlock = promptOpen ? (
    <>
      <PromptBox title="Setup prompt" text={prompt} copyWord="Copy setup prompt" testID="bot-setup-prompt" />
      <Text variant="treeMeta" style={styles.muted}>
        {again}
      </Text>
    </>
  ) : null;
  const hook =
    way === "check" ? (
      promptOpen || !mayChange ? null : <CopyPrompt text={prompt} />
    ) : workspaceId === undefined || workspaceId === "" ? (
      saved || mayChange ? null : <Text variant="treeMeta" style={styles.muted}>No webhook yet.</Text>
    ) : (
      <BotHookFields workspaceId={workspaceId} bot={bot.name} canEdit={mayChange} {...(promptOpen ? {} : { extra: <CopyPrompt text={prompt} /> })} />
    );

  return (
    <View style={styles.section} testID="bot-setup">
      <Text variant="eyebrow" style={styles.eyebrow}>
        Setup
      </Text>
      {/* A saved webhook is how it is reached (`bots.ts` `withHooks`), so the choice is only before one is saved. */}
      {mayChange && chooseMany !== undefined && row === null ? (
        <View style={styles.ways} role="radiogroup" accessibilityLabel={`How ${bot.name} reaches Context`}>
          {WAYS.map((option) => (
            <Pressable key={option.id} role="radio" aria-checked={way === option.id} onPress={() => void choose(option.id)} style={[styles.way, way === option.id && styles.wayOn]} testID={`bot-setup-way-${option.id}`}>
              <Text variant="treeMeta" style={way === option.id ? styles.wayWordOn : styles.buttonWord}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {/* Its app's way, and why (`botApps.cjs`), while there is still a choice. */}
      {mayChange && row === null && appOf(bot.card.bot) !== null ? (
        <Text variant="treeMeta" style={styles.muted} testID="bot-setup-why">
          {appOf(bot.card.bot)?.why}
        </Text>
      ) : null}
      {mayChange && chooseMany !== undefined && row === null ? null : way === "check" ? (
        <Text variant="treeMeta" style={styles.muted} testID="bot-setup-way">
          Checks in every 5 min
        </Text>
      ) : null}
      {problem === null ? null : (
        <Text variant="treeMeta" style={styles.problem}>
          {problem}
        </Text>
      )}
      {/* Someone who can't change it is told who can, and what puts it back in good standing (Dev, 2026-11-27). */}
      {failing && !mayChange ? (
        <Text variant="treeMeta" style={styles.muted} testID="bot-setup-fix">
          {`To fix it, ${bot.whose || "its person"} pastes its setup prompt into ${bot.name} again.`}
        </Text>
      ) : null}
      {/* A saved webhook first, then the prompt that sets it again; with none yet, the prompt leads. */}
      {saved ? hook : null}
      {promptBlock}
      {saved ? null : hook}
    </View>
  );
}

/** Its setup prompt, copied from a button beside the webhook's own while it works. */
function CopyPrompt({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <Pressable role="button" onPress={() => void writeClipboard(text).then((ok) => setSaid(ok ? "Copied" : "Couldn't copy"))} style={styles.button} testID="bot-setup-copy">
      <Text variant="treeMeta" style={styles.buttonWord}>
        {said ?? "Copy setup prompt"}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x2, paddingBottom: space.x3, borderBottomWidth: 1, borderBottomColor: colors.line },
    eyebrow: { color: colors.muted },
    button: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    buttonWord: { color: colors.text, fontWeight: "600" },
    muted: { color: colors.muted },
    problem: { color: colors.critText },
    ways: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    way: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    wayOn: { borderColor: colors.text, backgroundColor: colors.text },
    wayWordOn: { color: colors.surface, fontWeight: "600" },
  });
