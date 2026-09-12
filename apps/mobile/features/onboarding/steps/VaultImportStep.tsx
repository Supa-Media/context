import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Check } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { OnboardingController } from "../useOnboarding";
import { pickObsidianVault } from "../vaultPicker";
import {
  batchVaultFiles,
  formatVaultBytes,
  planVaultFiles,
  type VaultPlan,
} from "../vaultImport";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; completed: number; total: number }
  | { kind: "complete"; created: number; skipped: number }
  | { kind: "failed"; message: string };

/** The fork between importing an existing vault and starting a new brain. */
export function VaultImportStep({ controller }: { controller: OnboardingController }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const importBatch = useAction(api.functions.files.importVaultBatch);
  const resetPrivacy = useAction(api.functions.files.resetPrivacy);
  const [plan, setPlan] = useState<VaultPlan | null>(null);
  const [pickingUnavailable, setPickingUnavailable] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });

  if (controller.structureStep.kind === "existing") {
    return (
      <View>
        <Text variant="rowSub" style={styles.lede}>
          This storage already has files in it. Context will use them in place, so there is
          nothing to upload or rearrange.
        </Text>
        <Card>
          <View style={styles.checks}>
            <Check tone="ok">Your existing vault paths stay exactly as they are.</Check>
            <Check tone="ok">Obsidian can keep syncing to the same storage.</Check>
          </View>
        </Card>
        <View style={styles.actions}>
          <Button label="Continue" variant="white" onPress={() => controller.finishVaultImport("existing")} testID="welcome-vault-existing" />
        </View>
      </View>
    );
  }

  const busy = upload.kind === "uploading";
  const select = async () => {
    setPickingUnavailable(false);
    setUpload({ kind: "idle" });
    const picked = await pickObsidianVault();
    if (picked.kind === "unavailable") {
      setPickingUnavailable(true);
      return;
    }
    if (picked.kind === "selected") setPlan(planVaultFiles(picked.files));
  };

  const start = async () => {
    const workspaceId = controller.claimed?.workspaceId;
    if (workspaceId === undefined || plan === null || plan.files.length === 0 || busy) return;
    setUpload({ kind: "uploading", completed: 0, total: plan.files.length });
    let completed = 0;
    let created = 0;
    let skipped = plan.skipped;
    try {
      for (const batch of batchVaultFiles(plan.files)) {
        const files = await Promise.all(batch.map(async (file) => ({
          path: file.path,
          bytes: await file.read(),
          contentType: file.contentType,
        })));
        const result = await importBatch({ workspaceId, files });
        completed += batch.length;
        created += result.created.length;
        skipped += result.skipped.length;
        setUpload({ kind: "uploading", completed, total: plan.files.length });
      }
      // An imported vault replaces the scaffold step, so it also needs the
      // all-private manifest that step would otherwise create. The repair
      // action derives its folder rules from what was actually uploaded.
      await resetPrivacy({ workspaceId });
      setUpload({ kind: "complete", created, skipped });
    } catch {
      setUpload({
        kind: "failed",
        message: "The upload stopped before it finished. Nothing already in the bucket was overwritten; choose Retry to continue safely.",
      });
    }
  };

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Have an Obsidian vault? Bring the whole folder with you — notes, folders, and
        attachments keep their existing paths.
      </Text>

      <Card>
        <View style={styles.checks}>
          <Check tone="ok">Your Markdown stays Markdown.</Check>
          <Check tone="ok">Existing files in the bucket are never overwritten.</Check>
          <Check tone="ok">Obsidian settings, plugin data, trash, and Git files are skipped.</Check>
        </View>
      </Card>

      {plan === null ? (
        <View style={styles.actions}>
          <Button label="Choose my vault folder" variant="white" onPress={() => void select()} testID="welcome-vault-choose" />
          <Button label="No, start fresh" variant="ghost" onPress={controller.skipVaultImport} testID="welcome-vault-skip" />
        </View>
      ) : (
        <Notice style={styles.notice}>
          <Text variant="check" role="status">
            {plan.files.length} files · {formatVaultBytes(plan.totalBytes)} ready
            {plan.skipped > 0 ? ` · ${plan.skipped} safely skipped` : ""}
          </Text>
          {plan.skipped > 0 ? (
            <Text variant="meta" style={styles.skipDetail}>
              Skipped items are Obsidian or system metadata, protected Context files,
              duplicates, or files larger than 4.5 MB.
            </Text>
          ) : null}
        </Notice>
      )}

      {pickingUnavailable ? (
        <Notice tone="warn" style={styles.notice}>
          <Text variant="check">Vault-folder upload is available in the Context Mac app and web console. Open either one to preserve the folder structure.</Text>
        </Notice>
      ) : null}

      {upload.kind === "uploading" ? (
        <Notice style={styles.notice}>
          <View style={styles.progressRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status">
              Uploading {upload.completed} of {upload.total} files · {Math.round((upload.completed / upload.total) * 100)}%
            </Text>
          </View>
        </Notice>
      ) : null}

      {upload.kind === "failed" ? <FormError headline="The vault upload paused." next={upload.message} style={styles.notice} /> : null}

      {upload.kind === "complete" ? (
        <Notice tone="ok" style={styles.notice}>
          <Text variant="check" role="status" style={styles.okText}>
            Vault ready — {upload.created} files uploaded{upload.skipped > 0 ? `, ${upload.skipped} already there or skipped` : ""}.
          </Text>
        </Notice>
      ) : null}

      {plan !== null ? (
        <View style={styles.actions}>
          {upload.kind === "complete" ? (
            <Button label="Continue" variant="white" onPress={() => controller.finishVaultImport("imported")} testID="welcome-vault-continue" />
          ) : (
            <Button label={upload.kind === "failed" ? "Retry upload" : "Upload vault"} variant="white" disabled={busy || plan.files.length === 0} onPress={() => void start()} testID="welcome-vault-upload" />
          )}
          {!busy && upload.kind !== "complete" ? <Button label="Choose another folder" variant="ghost" onPress={() => void select()} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  checks: { gap: 9 },
  actions: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  notice: { marginTop: 14 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  skipDetail: { marginTop: 7, color: colors.muted },
  okText: { color: colors.okText },
});
