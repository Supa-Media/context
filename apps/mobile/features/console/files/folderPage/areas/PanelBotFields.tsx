/**
 * Bots in the area panel (the owner, 2026-11-25: "I want to be able to support
 * agents that can be prompted. In particular, different grok bots"): adding a
 * Grok bot as an area's owner by saying whose it is and its name, its card's
 * rows, and the prompt a person copies into the bot so it knows which area it
 * holds, or whose seats it holds for them.
 *
 * A bot is an agent of the workspace's `agents:` list whose card says `bot:`
 * (`seat.ts`). Nothing here stores a login: the card names whose bot it is and
 * how it is reached; a webhook's secret is kept sealed on the server.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { areaPrompt, botLabel, delegatePrompt } from "@context/shared/src/areaBots.cjs";
import { writeClipboard } from "../../../../design/clipboard";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MenuItem } from "../../menuItem";
import { agentName } from "../agents";
import { areaTitle, type Card, type Seat } from "./seat";

/** The words a bot is shown with in a menu: "@seyi's Grok bot". */
export function botDetail(card: Card, label: (owner: string) => string): string {
  const kind = botLabel(card.bot) || "Bot";
  return card.belongsTo.trim() === "" ? kind : `${label(card.belongsTo)}'s ${kind}`;
}

/** The prompt for the bot holding `seat`. */
export function seatPrompt(seat: Seat, card: Card, workspace: string | undefined): string {
  return areaPrompt({
    bot: card.holder,
    kind: card.bot,
    whose: card.belongsTo,
    ...(workspace === undefined ? {} : { workspace }),
    area: seat.folder,
    title: areaTitle(seat.name),
    modes: seat.modes,
    reach: card.reach,
  });
}

/** The prompt for the bot a person delegates to. */
export function personPrompt(person: string, bot: Card, workspace: string | undefined): string {
  return delegatePrompt({ bot: bot.holder, kind: bot.bot, whose: person, ...(workspace === undefined ? {} : { workspace }) });
}

/**
 * "+ Add a Grok bot…", typed where it is drawn: whose bot it is, from the
 * workspace's people, and its name. Adding writes the name to the agents
 * list, the bot's card, and the area's owner line, in that order.
 */
export function AddBotForm({
  people,
  label,
  onAdd,
  onCancel,
}: {
  people: readonly string[];
  label: (owner: string) => string;
  onAdd: (name: string, whose: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [name, setName] = useState("");
  const [whose, setWhose] = useState<string>(people[0] ?? "");
  const [menu, setMenu] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldFont = useFieldFont(pointerType.ui);
  const add = async () => {
    const named = agentName(name);
    if ("problem" in named) return setProblem(named.problem);
    if (whose.trim() === "") return setProblem("Say whose bot it is.");
    setBusy(true);
    const why = await onAdd(named.name, whose);
    setBusy(false);
    setProblem(why);
  };
  const items: MenuItem<string>[] = people.map((person) => ({ id: person, label: label(person), checked: person === whose }));
  return (
    <View style={styles.form} testID="area-panel-add-bot">
      <Text variant="treeMeta" style={styles.heading}>Add a Grok bot</Text>
      <View style={styles.row}>
        <Text variant="tree" style={styles.key}>Whose</Text>
        <Pressable role="button" aria-haspopup="menu" accessibilityLabel="Whose bot" onPress={() => setMenu(true)} style={styles.pick} testID="area-panel-add-bot-whose">
          <Text variant="tree" style={whose === "" ? styles.muted : styles.value} numberOfLines={1}>{whose === "" ? "Pick a person" : label(whose)}</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Text variant="tree" style={styles.key}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => void add()}
          autoFocus
          accessibilityLabel="The bot's name"
          placeholder="e.g. Finance"
          placeholderTextColor={colors.muted}
          style={[styles.input, fieldFont]}
          testID="area-panel-add-bot-name"
        />
      </View>
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.problem}>{problem}</Text>}
      <View style={styles.actions}>
        <Pressable role="button" disabled={busy} onPress={() => void add()} style={styles.primary} testID="area-panel-add-bot-save">
          <Text variant="treeMeta" style={styles.primaryWord}>{busy ? "Adding…" : "Add bot"}</Text>
        </Pressable>
        <Pressable role="button" onPress={onCancel} style={styles.ghost} testID="area-panel-add-bot-cancel">
          <Text variant="treeMeta" style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
      {menu ? (
        <Menu<string>
          items={items}
          title="Whose bot"
          onSelect={(id) => {
            setMenu(false);
            setWhose(id);
          }}
          onDismiss={() => setMenu(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * A prompt to paste into a bot, with its Copy button, folded to its first line
 * until opened so the panel stays short. Copy says whether it worked.
 */
export function PromptBox({ title, text, testID }: { title: string; text: string; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const copy = async () => setSaid((await writeClipboard(text)) ? "Copied" : "Couldn't copy: select the text and copy it");
  return (
    <View style={styles.prompt} testID={testID}>
      <View style={styles.promptHead}>
        <Pressable role="button" aria-expanded={open} onPress={() => setOpen(!open)} style={styles.flex} testID={`${testID}-toggle`}>
          <Text variant="treeMeta" style={styles.heading}>{title}</Text>
        </Pressable>
        <Pressable role="button" onPress={() => void copy()} style={styles.primary} testID={`${testID}-copy`}>
          <Text variant="treeMeta" style={styles.primaryWord}>{said === "Copied" ? "Copied" : "Copy prompt"}</Text>
        </Pressable>
      </View>
      {said !== null && said !== "Copied" ? <Text variant="treeMeta" role="alert" style={styles.problem}>{said}</Text> : null}
      <Text variant="treeMeta" selectable style={styles.promptText} numberOfLines={open ? undefined : 2} testID={`${testID}-text`}>
        {text}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { gap: space.x2, padding: space.x3, borderWidth: 1, borderColor: colors.line, borderRadius: radii.md },
    heading: { color: colors.text2, fontWeight: "600" },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 28 },
    key: { width: 64, color: colors.text2 },
    value: { color: colors.text },
    muted: { color: colors.muted },
    pick: { flexGrow: 1, flexShrink: 1, minWidth: 0, paddingVertical: 3, paddingHorizontal: 6, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    input: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontFamily: fonts.body, color: colors.text, paddingVertical: 3, paddingHorizontal: 6, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    problem: { color: colors.critText },
    actions: { flexDirection: "row", gap: space.x2, alignItems: "center" },
    primary: { paddingVertical: 4, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    primaryWord: { color: colors.surface, fontWeight: "600" },
    ghost: { paddingVertical: 4, paddingHorizontal: space.x2 },
    link: { color: colors.accent },
    prompt: { gap: space.x2, marginTop: space.x2 },
    promptHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    flex: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    promptText: { color: colors.text2, padding: space.x2, borderRadius: radii.sm, backgroundColor: colors.chipFill },
  });
