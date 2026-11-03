import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import { settingsSectionLabel } from "../sections";
import { PickMenu, type PickOption } from "./PickMenu";

/**
 * Settings › Tex (Dev2, 2026-11-01; docs/decisions/texting-assistant/custom-instructions.md):
 * how Tex talks to this person in their own chat, in their own words, and its
 * progress updates. A quick pick adds its line to the text (the control plane
 * keeps the catalog and writes it); a group chat keeps its own and is changed there.
 */
export type Updates = "off" | "planOnly" | "normal";
type Saved = { instructions?: string; updates?: Updates } | { refused: string };

/** The control plane's limit (`MAX_INSTRUCTIONS`). */
export const MAX_INSTRUCTIONS = 1_500;
const UPDATES: readonly PickOption<Updates>[] = [
  { key: "off", label: "Off" },
  { key: "planOnly", label: "Plan only" },
  { key: "normal", label: "Normal" },
];

export function TexSettings() {
  const styles = useThemedStyles(makeStyles);
  const live = useConvex() !== undefined;
  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("tex")}
      </Text>
      {/* Nothing to read or save without a client: the demo and the render tests. */}
      {live ? <TexSettingsLive /> : null}
    </View>
  );
}

function TexSettingsLive() {
  const saved = useQuery(api.functions.texStyle.myTexStyle, {});
  const save = useMutation(api.functions.texStyle.setMyTexStyle);
  const [text, setText] = useState("");
  // What the account holds now, so leaving the box unchanged saves nothing (and keeps "Tex, undo the change" for a real one).
  const [kept, setKept] = useState("");
  const [updates, setUpdates] = useState<Updates>("normal");
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setText(saved.instructions ?? "");
    setKept(saved.instructions ?? "");
    setUpdates(saved.updates ?? "normal");
  }, [saved]);

  async function send(args: Parameters<typeof save>[0]) {
    setProblem(false);
    try {
      const answer = (await save(args)) as Saved;
      if ("refused" in answer) return setProblem(true);
      setText(answer.instructions ?? "");
      setKept(answer.instructions ?? "");
      setUpdates(answer.updates ?? "normal");
    } catch {
      setProblem(true);
    }
  }

  return (
    <TexSettingsView
      text={text}
      updates={updates}
      picks={saved?.picks ?? []}
      problem={problem}
      onText={setText}
      onSave={() => void (text.trim() !== kept && send({ change: { replace: text } }))}
      onPick={(pick) => void send({ change: { pick } })}
      onUpdates={(level) => (setUpdates(level), void send({ updates: level }))}
    />
  );
}

/** What the page draws, with no client behind it. */
export function TexSettingsView({
  text,
  updates,
  picks,
  problem,
  onText,
  onSave,
  onPick,
  onUpdates,
}: {
  text: string;
  updates: Updates;
  picks: readonly { id: string; label: string }[];
  problem: boolean;
  onText: (text: string) => void;
  onSave: () => void;
  onPick: (pick: string) => void;
  onUpdates: (level: Updates) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <TextField
        label="How Tex talks to you"
        value={text}
        onChangeText={onText}
        onBlur={onSave}
        multiline
        maxLength={MAX_INSTRUCTIONS}
        testID="tex-instructions"
      />
      <View style={styles.actions}>
        <PickMenu
          label="Add a quick pick"
          options={picks.map(({ id, label }) => ({ key: id, label }))}
          onPick={onPick}
          accessibilityLabel="Add a quick pick to how Tex talks"
          testID="tex-picks"
        />
        <Button label="Save" onPress={onSave} testID="tex-save" />
      </View>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Progress updates</Text>
          </Grow>
          <PickMenu
            label={UPDATES.find((option) => option.key === updates)!.label}
            options={UPDATES}
            selected={updates}
            onPick={onUpdates}
            accessibilityLabel="Tex's progress updates on long tasks"
            testID="tex-updates"
          />
        </Row>
      </Card>
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="tex-unsaved">
          Not saved. Try again.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginBottom: space.x3 },
    actions: { flexDirection: "row", gap: space.x2, marginVertical: space.x3, alignItems: "center" },
    problem: { marginTop: space.x2 },
  });
