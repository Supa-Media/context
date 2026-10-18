/**
 * New experiment (board 18): the one way the job page starts a change to a
 * prompt. It copies the live setup into a new note under
 * `ai/setups/<job>/`, asks what one thing is changing, and opens the copy in
 * the note editor. Live is never edited from here; it changes only when a
 * person makes an experiment live on Compare. The sentence becomes the
 * experiment's name and its `change:`, so the Setups list and Compare say
 * what it tries without opening it (`experimentText`).
 */

import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Text, space, useColors, useThemedStyles, type Colors } from "../design";
import { useFieldFont } from "../design/fieldFont";
import { pointerType } from "../design/tokens";
import { Box, Primary, Quiet } from "./AiKit";
import { experimentPath, experimentText } from "./aiExperiments";
import { messageOf, useNoteMoves, useNoteWriter } from "./useAiNote";

export function AiNewExperiment({ workspaceId, job, livePath, liveName, liveTitle, taken, me, onMade, onCancel }: {
  workspaceId: Id<"workspaces">;
  job: string;
  /** The production note: what is copied. */
  livePath: string;
  /** The setup live came from, which the experiment says it is based on. */
  liveName: string;
  liveTitle: string;
  /** Setup names already used in the job's folder, live and archived. */
  taken: ReadonlySet<string>;
  me: string;
  onMade: (path: string) => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const write = useNoteWriter(workspaceId);
  const { read } = useNoteMoves(workspaceId);
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const create = async () => {
    const said = change.trim();
    if (said === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const liveText = await read(livePath);
      const path = experimentPath(job, said, taken);
      // A note already at that path is left alone: the writer answers null over existing text.
      await write(path, (existing) => (existing === null ? experimentText(liveText, { job, basedOn: liveName, change: said, by: me }) : null));
      onMade(path);
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box title="New experiment" testID="admin-ai-new-experiment">
      <Text variant="meta">{`A copy of ${liveTitle}, the live setup. Live stays exactly as it is.`}</Text>
      <Text variant="eyebrow" style={styles.label}>WHAT ONE THING ARE YOU CHANGING?</Text>
      <TextInput
        value={change}
        onChangeText={setChange}
        onSubmitEditing={() => void create()}
        placeholder="Reminder rules move into a skill"
        placeholderTextColor={colors.muted}
        style={[styles.input, fieldFont]}
        accessibilityLabel="What one thing are you changing?"
        autoFocus
        testID="admin-ai-new-experiment-change"
      />
      <Text variant="meta" style={styles.muted}>One sentence. It becomes the name. Changing two things? Make two experiments, so each result means something.</Text>
      {problem ? <Text variant="meta" style={styles.problem} testID="admin-ai-new-experiment-problem">{problem}</Text> : null}
      <View style={styles.buttons}>
        <Primary label={busy ? "Copying…" : "Copy live and edit"} disabled={busy || change.trim() === ""} onPress={() => void create()} testID="admin-ai-new-experiment-create" />
        <Quiet label="Cancel" onPress={onCancel} testID="admin-ai-new-experiment-cancel" />
      </View>
    </Box>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    label: { marginTop: space.x2 },
    input: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x3, paddingVertical: space.x2, color: colors.text },
    muted: { color: colors.muted },
    problem: { color: colors.critText },
    buttons: { flexDirection: "row", gap: space.x2, marginTop: space.x2 },
  });
