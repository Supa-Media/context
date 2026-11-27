/**
 * Refresh all, on the bots page (Dev2, 2026-11-27: "maybe a refresh all button?"): each bot the page lists is mailed
 * its setup again, one after another, as its own panel's Refresh does (`refreshBot.ts`), and each panel then says
 * when its own bot was refreshed.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { useMailIO } from "../../../mailPage/useMailIO";
import type { ListNote } from "../../listBlock/model";
import { botMailNote, type Bot } from "./bots";
import { noteStarted, refreshBot, startedMail, type RefreshIO } from "./refreshBot";

export interface RefreshAllProps {
  bots: readonly Bot[];
  notes: readonly ListNote[];
  me: string;
  workspace?: string;
  create: (path: string, text: string) => Promise<unknown>;
  io?: RefreshIO;
}

/** Sends each bot its Refresh and says how it went: "Refreshed 3 bots", or which didn't go. */
export async function refreshAll({ bots, notes, me, workspace, create, io }: RefreshAllProps): Promise<string> {
  const failed: string[] = [];
  let sent = 0;
  for (const bot of bots) {
    const path = botMailNote(bot, me);
    const exists = notes.some((note) => note.path === path) || startedMail(path);
    const result = await refreshBot(bot, { me, ...(workspace === undefined ? {} : { workspace }), exists, create, ...(io === undefined ? {} : { io }) });
    if ("error" in result) failed.push(bot.name);
    else {
      sent += 1;
      if (result.started) noteStarted(result.path);
    }
  }
  const done = `Refreshed ${sent} ${sent === 1 ? "bot" : "bots"}`;
  return failed.length === 0 ? done : `${done}; ${failed.join(", ")} didn't send. Try again.`;
}

export function RefreshAllButton(props: RefreshAllProps) {
  const styles = useThemedStyles(makeStyles);
  const [running, setRunning] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      setSaid(await refreshAll(props));
    } finally {
      setRunning(false);
    }
  };
  return (
    <View style={styles.bar}>
      {said !== null ? (
        <Text variant="treeMeta" style={[styles.muted, styles.grow]} numberOfLines={2} testID="bots-refresh-all-said">
          {said}
        </Text>
      ) : (
        <View style={styles.grow} />
      )}
      <Pressable
        onPress={() => void run()}
        disabled={running}
        accessibilityRole="button"
        accessibilityLabel="Ask every bot here to refresh its setup, name and logo"
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover, running && styles.dim]}
        testID="bots-refresh-all"
      >
        <Text variant="treeMeta" style={styles.word}>
          {running ? "Sending…" : "Refresh all"}
        </Text>
      </Pressable>
    </View>
  );
}

function Live({ workspaceId, ...props }: RefreshAllProps & { workspaceId: string }) {
  const io = useMailIO(workspaceId);
  return <RefreshAllButton {...props} io={io} />;
}

/** With the workspace's note reads and saves where the page names its workspace; elsewhere (a fixture) without. */
export function AnyRefreshAll({ workspaceId, ...props }: RefreshAllProps & { workspaceId?: string }) {
  return workspaceId === undefined || workspaceId === "" ? <RefreshAllButton {...props} /> : <Live {...props} workspaceId={workspaceId} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    grow: { flexGrow: 1, flexShrink: 1 },
    muted: { color: colors.muted },
    button: { paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.control, borderWidth: 1, borderColor: colors.line },
    hover: { backgroundColor: colors.chipFill },
    dim: { opacity: 0.6 },
    word: { fontWeight: "600" },
  });
