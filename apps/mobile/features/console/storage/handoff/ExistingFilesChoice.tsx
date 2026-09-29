import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Row } from "../../../design/components/Card";
import { FormError, TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { EXISTING } from "./copy";

export type ExistingFilesAnswer =
  | { choice: "merge" }
  | { choice: "replace"; confirmBucket: string };

/**
 * The two answers for a bucket that already has files: keep them and merge,
 * or delete them and start fresh.
 *
 * Context uses the whole bucket, never a folder of it (owner, 2026-09-29), so
 * this replaces the old advice to pick an empty bucket or a prefix. Starting
 * fresh deletes somebody's files, so its button stays off until the bucket's
 * name is typed; the server checks the same name again.
 */
export function ExistingFilesChoice({
  bucket,
  onChoose,
  onOther,
}: {
  bucket: string;
  onChoose: (answer: ExistingFilesAnswer) => Promise<unknown>;
  onOther: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const choose = async (answer: ExistingFilesAnswer) => {
    setBusy(true);
    setFailed(null);
    try {
      await onChoose(answer);
    } catch {
      setFailed("That didn't go through. Nothing was deleted. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.options} testID="storage-existing-files">
      <View style={styles.option}>
        <Text variant="rowTitle">{EXISTING.merge.title}</Text>
        <Text variant="rowSub">{EXISTING.merge.body}</Text>
        <Row style={styles.actions}>
          <Button
            label={EXISTING.merge.button}
            variant="accent"
            disabled={busy}
            onPress={() => void choose({ choice: "merge" })}
            testID="storage-existing-merge"
          />
        </Row>
      </View>
      <View style={styles.option}>
        <Text variant="rowTitle">{EXISTING.fresh.title}</Text>
        <Text variant="rowSub">{EXISTING.fresh.body(bucket)}</Text>
        <TextField
          label={EXISTING.fresh.field}
          placeholder={bucket}
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="none"
          autoCorrect={false}
          testID="storage-existing-confirm"
        />
        <Row style={styles.actions}>
          <Button
            label={EXISTING.fresh.button}
            variant="danger"
            disabled={busy || typed.trim() !== bucket}
            onPress={() => void choose({ choice: "replace", confirmBucket: typed.trim() })}
            testID="storage-existing-fresh"
          />
        </Row>
      </View>
      {failed === null ? null : <FormError headline={failed} />}
      <Row style={styles.actions}>
        <Button label={EXISTING.other} onPress={onOther} testID="storage-handoff" />
      </Row>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    options: { marginTop: 12, gap: 12 },
    option: {
      gap: 6,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 8,
    },
    actions: { marginTop: 6, flexWrap: "wrap", gap: 8 },
  });
