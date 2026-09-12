import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Check } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { pickObsidianVault } from "../../onboarding/vaultPicker";
import { batchVaultFiles, formatVaultBytes, planVaultFiles, type VaultPlan } from "../../onboarding/vaultImport";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; completed: number; total: number }
  | { kind: "complete"; created: number; skipped: number }
  | { kind: "failed"; message: string };

interface ImportResult {
  created: string[];
  skipped: string[];
}

/**
 * The same create-only folder importer is used during onboarding and later in
 * Settings. Keeping one implementation makes overwrite rules, filtering, and
 * privacy repair identical no matter when somebody brings their notes in.
 */
export function VaultImport({
  workspaceId,
  onSkip,
  onComplete,
  initializePrivacy = false,
  testIDPrefix = "vault",
}: {
  workspaceId: Id<"workspaces">;
  onSkip?: () => void;
  onComplete?: () => void;
  /** Fresh onboarding storage has no access map yet; established storage does. */
  initializePrivacy?: boolean;
  testIDPrefix?: string;
}) {
  const importBatch = useAction(api.functions.files.importVaultBatch);
  const resetPrivacy = useAction(api.functions.files.resetPrivacy);
  return (
    <VaultImportBody
      workspaceId={workspaceId}
      importBatch={importBatch}
      resetPrivacy={initializePrivacy ? resetPrivacy : undefined}
      onSkip={onSkip}
      onComplete={onComplete}
      testIDPrefix={testIDPrefix}
    />
  );
}

/** Hook-free seam for render tests and fixtures. */
export function VaultImportBody({
  workspaceId,
  importBatch,
  resetPrivacy,
  onSkip,
  onComplete,
  testIDPrefix = "vault",
}: {
  workspaceId: Id<"workspaces">;
  importBatch: (args: {
    workspaceId: Id<"workspaces">;
    files: { path: string; bytes: ArrayBuffer; contentType: string }[];
  }) => Promise<ImportResult>;
  resetPrivacy?: (args: { workspaceId: Id<"workspaces"> }) => Promise<unknown>;
  onSkip?: () => void;
  onComplete?: () => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [plan, setPlan] = useState<VaultPlan | null>(null);
  const [pickingUnavailable, setPickingUnavailable] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
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
    if (plan === null || plan.files.length === 0 || busy) return;
    setUpload({ kind: "uploading", completed: 0, total: plan.files.length });
    let completed = 0;
    let created = 0;
    let skipped = plan.skipped;
    try {
      for (const batch of batchVaultFiles(plan.files)) {
        const files = await Promise.all(
          batch.map(async (file) => ({
            path: file.path,
            bytes: await file.read(),
            contentType: file.contentType,
          })),
        );
        const result = await importBatch({ workspaceId, files });
        completed += batch.length;
        created += result.created.length;
        skipped += result.skipped.length;
        setUpload({ kind: "uploading", completed, total: plan.files.length });
      }
      // A fresh import replaces onboarding's scaffold step, so it needs the
      // all-private access map that step would have created. Settings imports
      // leave a workspace's existing access map alone.
      if (resetPrivacy !== undefined) await resetPrivacy({ workspaceId });
      setUpload({ kind: "complete", created, skipped });
    } catch {
      setUpload({
        kind: "failed",
        message:
          "The upload stopped before it finished. Files already in storage were not overwritten. Choose Retry to continue safely.",
      });
    }
  };

  return (
    <View testID={`${testIDPrefix}-import`}>
      <Text variant="rowTitle">Have an Obsidian vault or existing Markdown notes?</Text>
      <Text variant="rowSub" style={styles.lede}>
        Choose the folder that holds them. Context keeps the existing paths and includes attachments alongside your
        Markdown files.
      </Text>

      <Card>
        <View style={styles.checks}>
          <Check tone="ok">Your Markdown stays Markdown.</Check>
          <Check tone="ok">Files already in storage are never overwritten.</Check>
          <Check tone="ok">Obsidian settings, plugin data, trash, and Git files are skipped.</Check>
        </View>
      </Card>

      {plan === null ? (
        <View style={styles.actions}>
          <Button
            label="Choose a vault or notes folder"
            variant="white"
            onPress={() => void select()}
            testID={`${testIDPrefix}-choose`}
          />
          {onSkip === undefined ? null : (
            <Button label="No, start fresh" variant="ghost" onPress={onSkip} testID={`${testIDPrefix}-skip`} />
          )}
        </View>
      ) : (
        <Notice style={styles.notice}>
          <Text variant="check" role="status">
            {plan.files.length} files · {formatVaultBytes(plan.totalBytes)} ready
            {plan.skipped > 0 ? ` · ${plan.skipped} safely skipped` : ""}
          </Text>
          {plan.skipped > 0 ? (
            <Text variant="meta" style={styles.skipDetail}>
              Skipped items are Obsidian or system metadata, protected Context files, duplicates, or files larger than
              4.5 MB.
            </Text>
          ) : null}
        </Notice>
      )}

      {pickingUnavailable ? (
        <Notice tone="warn" style={styles.notice}>
          <Text variant="check">
            Folder upload is available in the Context Mac app and web console. Open either one to preserve the folder
            structure.
          </Text>
        </Notice>
      ) : null}

      {upload.kind === "uploading" ? (
        <Notice style={styles.notice}>
          <View style={styles.progressRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status">
              Uploading {upload.completed} of {upload.total} files ·{" "}
              {Math.round((upload.completed / upload.total) * 100)}%
            </Text>
          </View>
        </Notice>
      ) : null}

      {upload.kind === "failed" ? (
        <FormError headline="The folder upload paused." next={upload.message} style={styles.notice} />
      ) : null}

      {upload.kind === "complete" ? (
        <Notice tone="ok" style={styles.notice}>
          <Text variant="check" role="status" style={styles.okText}>
            Import complete. {upload.created} files uploaded
            {upload.skipped > 0 ? `, ${upload.skipped} already there or skipped` : ""}.
          </Text>
        </Notice>
      ) : null}

      {plan !== null ? (
        <View style={styles.actions}>
          {upload.kind === "complete" && onComplete !== undefined ? (
            <Button label="Continue" variant="white" onPress={onComplete} testID={`${testIDPrefix}-continue`} />
          ) : upload.kind === "complete" ? null : (
            <Button
              label={upload.kind === "failed" ? "Retry upload" : "Upload notes"}
              variant="white"
              disabled={busy || plan.files.length === 0}
              onPress={() => void start()}
              testID={`${testIDPrefix}-upload`}
            />
          )}
          {!busy && upload.kind !== "complete" ? (
            <Button label="Choose another folder" variant="ghost" onPress={() => void select()} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { marginTop: 6, marginBottom: 18, lineHeight: leading(12.5, 1.7) },
    checks: { gap: 9 },
    actions: {
      marginTop: 18,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    },
    notice: { marginTop: 14 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    skipDetail: { marginTop: 7, color: colors.muted },
    okText: { color: colors.okText },
  });
