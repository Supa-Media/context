import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Switch } from "../../../design/components/Switch";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { settingsSectionLabel } from "../sections";
import { foldersLine, thisMacLine, useThisMac } from "../../../tex/page/useThisMac";

/**
 * Settings › Tex (Dev2, 2026-11-01; docs/decisions/texting-assistant/custom-instructions.md):
 * how Tex talks to this person in their own chat, in their own words, the same
 * text Tex changes when they ask it to. Quick picks and progress updates are
 * retired (Dev2, 2026-11-11; docs/decisions/texting-assistant/retire-settings.md);
 * a group chat keeps its own words and is changed there.
 */
type Saved = { instructions?: string } | { refused: string };

/** The control plane's limit (`MAX_INSTRUCTIONS`). */
export const MAX_INSTRUCTIONS = 1_500;

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
      <ThisMac />
    </View>
  );
}

/**
 * "Let Tex use this Mac", inside the Mac app only (`useThisMac` is null
 * anywhere else, so nothing is drawn). The Tex page's connect screen sends a
 * Mac owner here ("open Settings › Tex"), and the Mac app has no link to the
 * Tex page, so the switch must be here as well as on the Tex page's settings.
 */
function ThisMac() {
  const styles = useThemedStyles(makeStyles);
  const thisMac = useThisMac();
  if (thisMac === null) return null;
  return (
    <Card style={styles.mac} testID="tex-this-mac">
      <Row>
        <Grow>
          <Text variant="rowTitle">Let Tex use this Mac</Text>
          <Text variant="rowSub">{thisMacLine(thisMac.status)}</Text>
        </Grow>
        {thisMac.status.available ? (
          <Switch value={thisMac.status.enabled} label="Let Tex use this Mac" onValueChange={thisMac.setEnabled} testID="tex-this-mac-switch" />
        ) : null}
      </Row>
      {/* Only while it is on: a folder choice for a Mac Tex can't use is noise (artboard audit, finding 1). */}
      {thisMac.status.enabled && thisMac.folders !== null ? (
        <View style={styles.folders} testID="tex-this-mac-folders">
          <Row>
            <Grow>
              <Text variant="rowTitle">Folders Tex can work in</Text>
              <Text variant="rowSub">{foldersLine(thisMac.folders.list, thisMac.folders.failed)}</Text>
            </Grow>
            <Button
              label={thisMac.folders.list && thisMac.folders.list.length > 0 ? "Change…" : "Choose…"}
              variant="dialog"
              onPress={thisMac.folders.choose}
              testID="tex-this-mac-folders-choose"
            />
          </Row>
        </View>
      ) : null}
    </Card>
  );
}

function TexSettingsLive() {
  const saved = useQuery(api.functions.texStyle.myTexStyle, {});
  const save = useMutation(api.functions.texStyle.setMyTexStyle);
  const [text, setText] = useState("");
  // What the account holds now, so leaving the box unchanged saves nothing (and keeps "Tex, undo the change" for a real one).
  const [kept, setKept] = useState("");
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setText(saved.instructions ?? "");
    setKept(saved.instructions ?? "");
  }, [saved]);

  async function send(args: Parameters<typeof save>[0]) {
    setProblem(false);
    try {
      const answer = (await save(args)) as Saved;
      if ("refused" in answer) return setProblem(true);
      setText(answer.instructions ?? "");
      setKept(answer.instructions ?? "");
    } catch {
      setProblem(true);
    }
  }

  return (
    <TexSettingsView
      text={text}
      problem={problem}
      onText={setText}
      onSave={() => void (text.trim() !== kept && send({ change: { replace: text } }))}
    />
  );
}

/** What the page draws, with no client behind it. */
export function TexSettingsView({
  text,
  problem,
  onText,
  onSave,
}: {
  text: string;
  problem: boolean;
  onText: (text: string) => void;
  onSave: () => void;
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
      <Text variant="hint" style={styles.hint}>
        Or just tell Tex in a text, like "no emoji" or "call me Sam".
      </Text>
      <View style={styles.actions}>
        <Button label="Save" onPress={onSave} testID="tex-save" />
      </View>
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="tex-unsaved">
          Not saved. Try again.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: space.x3 },
    actions: { flexDirection: "row", gap: space.x2, marginVertical: space.x3, alignItems: "center" },
    problem: { marginTop: space.x2 },
    hint: { marginTop: space.x2 },
    mac: { marginTop: space.x3 },
    folders: { marginTop: space.x3, paddingTop: space.x3, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  });
