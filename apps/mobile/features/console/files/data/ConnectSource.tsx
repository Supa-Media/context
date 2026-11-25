/**
 * Connect a source, as this stage can: **Send from your code**. It makes the
 * source's folder in the data folder — `about.md` saying `source: push`, and
 * one dataset sheet with the columns named here — and then the sheet's own
 * key flow makes a key, shown once (`sheet/SheetSources.tsx`). GitHub,
 * Cloudflare, Stripe and Fetch from a URL are later stages and are not
 * offered until they work.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Shell } from "../DialogShell";
import { pushSourceFiles, type PushSourceFiles } from "./dataWrites";
import { SourceMark } from "./Marks";

export function ConnectSourceDialog({
  dataFolder,
  taken,
  sheet,
  onMake,
  onClose,
}: {
  dataFolder: string;
  /** Every path under the data folder now, so a new source never lands on one. */
  taken: ReadonlySet<string>;
  /** A phone's sheet on the bottom of the glass. */
  sheet: boolean;
  /** Write the two files; resolves to null once written, or to why not. */
  onMake: (files: PushSourceFiles) => Promise<string | null>;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [name, setName] = useState("");
  const [dataset, setDataset] = useState("");
  const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = name.trim() !== "" && dataset.trim() !== "" && !busy;
  const make = async () => {
    if (!ready) return;
    const files = pushSourceFiles(dataFolder, name, dataset, columns, taken);
    if (typeof files === "string") {
      setProblem(files);
      return;
    }
    setBusy(true);
    setProblem(null);
    const why = await onMake(files).catch(() => "That did not work. Try again.");
    setBusy(false);
    if (why !== null) setProblem(why);
  };
  return (
    <Shell title="Connect a source" onClose={onClose} sheet={sheet}>
      <View style={styles.way} testID="connect-push">
        <SourceMark kind="push" size={28} />
        <View style={styles.wayText}>
          <Text style={styles.wayTitle}>Send from your code</Text>
          <Text style={styles.wayLine}>A key lets a script or CI job add rows to one sheet. It can only add rows.</Text>
        </View>
      </View>
      <TextField label="Name" value={name} onChangeText={setName} placeholder="Such as Eval CI" testID="connect-name" />
      <TextField label="Dataset" value={dataset} onChangeText={setDataset} placeholder="Such as bench-runs" testID="connect-dataset" />
      <TextField
        label="Columns"
        value={columns}
        onChangeText={setColumns}
        placeholder="suite, p95 ms:number, errors:number"
        hint="Separated by commas; add :number or :date after a name to type it. A date column is added when there is none."
        testID="connect-columns"
      />
      {problem === null ? null : (
        <Text variant="error" testID="connect-problem">
          {problem}
        </Text>
      )}
      <View style={styles.foot}>
        <Text style={[styles.lands, { color: colors.muted }]} numberOfLines={2}>
          Makes a folder in {dataFolder}/ with an about.md and the sheet. You make its key next.
        </Text>
        <Button label="Cancel" variant="dialog" onPress={onClose} />
        <Button label={busy ? "Making…" : "Make source"} variant="dialogPrimary" disabled={!ready} onPress={() => void make()} testID="connect-make" />
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    way: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.cardSurface,
    },
    wayText: { flexGrow: 1, flexShrink: 1 },
    wayTitle: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    wayLine: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    foot: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
    lands: { flexGrow: 1, flexShrink: 1, flexBasis: 200, fontSize: pointerType.meta, lineHeight: 16 },
  });
