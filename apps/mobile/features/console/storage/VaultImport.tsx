import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
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
import {
  batchVaultFiles,
  formatVaultBytes,
  planVaultFiles,
  vaultFingerprint,
  vaultPlanForStrategy,
  type VaultImportStrategy,
  type VaultPlan,
} from "../../onboarding/vaultImport";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; completed: number; total: number }
  | { kind: "complete"; created: number; skipped: number }
  | { kind: "failed"; message: string; completed: number; total: number };

interface VaultJobStatus {
  jobId: Id<"vaultImportJobs">;
  strategy: VaultImportStrategy;
  status: "active" | "paused" | "complete";
  totalFiles: number;
  completedFiles: number;
  createdFiles: number;
  skippedFiles: number;
  completedBatches?: number[];
}

function importPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function ImportProgress({ completed, total }: { completed: number; total: number }) {
  const styles = useThemedStyles(makeStyles);
  const percent = importPercent(completed, total);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: completed }}
      style={styles.progressTrack}
    >
      <View style={[styles.progressFill, { width: `${percent}%` }]} />
    </View>
  );
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
  existingData = false,
  testIDPrefix = "vault",
}: {
  workspaceId: Id<"workspaces">;
  onSkip?: () => void;
  onComplete?: () => void;
  /** Fresh onboarding storage has no access map yet; established storage does. */
  initializePrivacy?: boolean;
  /** Existing storage needs an explicit merge-or-folder choice before picking local files. */
  existingData?: boolean;
  testIDPrefix?: string;
}) {
  const importBatch = useAction(api.functions.files.importVaultJobBatch);
  const startJob = useMutation(api.functions.files.startVaultImport);
  const pauseJob = useMutation(api.functions.files.pauseVaultImport);
  const existingJob = useQuery(api.functions.files.latestVaultImportJob, { workspaceId });
  const resetPrivacy = useAction(api.functions.files.resetPrivacy);
  return (
    <VaultImportBody
      workspaceId={workspaceId}
      existingData={existingData}
      existingJob={existingJob ?? undefined}
      startJob={startJob}
      importBatch={importBatch}
      pauseJob={pauseJob}
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
  existingData = false,
  existingJob,
  startJob,
  importBatch,
  pauseJob,
  resetPrivacy,
  onSkip,
  onComplete,
  testIDPrefix = "vault",
}: {
  workspaceId: Id<"workspaces">;
  existingData?: boolean;
  existingJob?: Omit<VaultJobStatus, "jobId"> & { jobId?: Id<"vaultImportJobs"> };
  startJob: (args: {
    workspaceId: Id<"workspaces">;
    strategy: VaultImportStrategy;
    sourceFingerprint: string;
    totalFiles: number;
    totalBytes: number;
    totalBatches: number;
  }) => Promise<VaultJobStatus>;
  importBatch: (args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
    sourceFingerprint: string;
    batchIndex: number;
    files: { path: string; bytes: ArrayBuffer; contentType: string }[];
  }) => Promise<VaultJobStatus>;
  pauseJob?: (args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
  }) => Promise<unknown>;
  resetPrivacy?: (args: { workspaceId: Id<"workspaces"> }) => Promise<unknown>;
  onSkip?: () => void;
  onComplete?: () => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [strategy, setStrategy] = useState<VaultImportStrategy | null>(
    existingData ? existingJob?.strategy ?? null : "merge",
  );
  const [plan, setPlan] = useState<VaultPlan | null>(null);
  const [pickingUnavailable, setPickingUnavailable] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  const busy = upload.kind === "uploading";

  useEffect(() => {
    if (strategy === null && existingJob?.strategy !== undefined) setStrategy(existingJob.strategy);
  }, [existingJob?.strategy, strategy]);

  const select = async () => {
    if (strategy === null) return;
    setPickingUnavailable(false);
    setUpload({ kind: "idle" });
    const picked = await pickObsidianVault();
    if (picked.kind === "unavailable") {
      setPickingUnavailable(true);
      return;
    }
    if (picked.kind === "selected") setPlan(vaultPlanForStrategy(planVaultFiles(picked.files), strategy));
  };

  const start = async () => {
    if (plan === null || strategy === null || plan.files.length === 0 || busy) return;
    setUpload({ kind: "uploading", completed: 0, total: plan.files.length });
    let jobId: Id<"vaultImportJobs"> | undefined;
    let completed = 0;
    let total = plan.files.length;
    try {
      const batches = batchVaultFiles(plan.files);
      const sourceFingerprint = vaultFingerprint(plan, strategy);
      const job = await startJob({
        workspaceId,
        strategy,
        sourceFingerprint,
        totalFiles: plan.files.length,
        totalBytes: plan.totalBytes,
        totalBatches: batches.length,
      });
      jobId = job.jobId;
      let latest = job;
      completed = latest.completedFiles;
      total = latest.totalFiles;
      setUpload({ kind: "uploading", completed: latest.completedFiles, total: latest.totalFiles });
      const completedBatches = new Set(latest.completedBatches ?? []);
      for (const [batchIndex, batch] of batches.entries()) {
        if (completedBatches.has(batchIndex)) continue;
        const files = await Promise.all(
          batch.map(async (file) => ({
            path: file.path,
            bytes: await file.read(),
            contentType: file.contentType,
          })),
        );
        latest = await importBatch({ workspaceId, jobId, sourceFingerprint, batchIndex, files });
        completed = latest.completedFiles;
        total = latest.totalFiles;
        setUpload({ kind: "uploading", completed: latest.completedFiles, total: latest.totalFiles });
      }
      // A fresh import replaces onboarding's scaffold step, so it needs the
      // all-private access map that step would have created. Settings imports
      // leave a workspace's existing access map alone.
      if (resetPrivacy !== undefined) await resetPrivacy({ workspaceId });
      setUpload({
        kind: "complete",
        created: latest.createdFiles,
        skipped: latest.skippedFiles + plan.skipped,
      });
    } catch {
      if (jobId !== undefined && pauseJob !== undefined) {
        try {
          await pauseJob({ workspaceId, jobId });
        } catch {
          // The progress row already lives in Convex. A failed pause marker
          // must not replace the original upload failure or lose that count.
        }
      }
      setUpload({
        kind: "failed",
        completed,
        total,
        message:
          "The upload stopped before it finished. Return here, reselect the same vault, and Context will continue after the last completed batch.",
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

      <Notice tone="warn" style={styles.notice}>
        <Text variant="check">
          Keep this tab open while files upload. The vault stays on this device. If the tab closes or the connection
          fails, return here and reselect the same vault to resume from the saved count.
        </Text>
      </Notice>

      {existingJob !== undefined && existingJob.status !== "complete" && upload.kind === "idle" ? (
        <Notice style={styles.notice}>
          <Text variant="check" role="status">
            {existingJob.completedFiles} of {existingJob.totalFiles} files finished ·{" "}
            {importPercent(existingJob.completedFiles, existingJob.totalFiles)}%
          </Text>
          <ImportProgress completed={existingJob.completedFiles} total={existingJob.totalFiles} />
          <Text variant="meta" style={styles.skipDetail}>
            Choose the same vault to resume. Completed batches will not upload again.
          </Text>
        </Notice>
      ) : null}

      {existingData && strategy === null ? (
        <View style={styles.choiceBlock}>
          <Text variant="rowTitle">How should this vault join your existing notes?</Text>
          <Text variant="rowSub" style={styles.choiceDetail}>
            Neither option replaces a file already in this brain or workspace.
          </Text>
          <View style={styles.actions}>
            <Button
              label="Merge without replacing"
              variant="white"
              onPress={() => setStrategy("merge")}
              testID={`${testIDPrefix}-merge`}
            />
            <Button
              label="Keep it in its own folder"
              variant="white"
              onPress={() => setStrategy("folder")}
              testID={`${testIDPrefix}-folder`}
            />
          </View>
          <Text variant="meta" style={styles.skipDetail}>
            Merge keeps the vault's paths and skips collisions. Its own folder puts everything under Imports/Vault name.
          </Text>
        </View>
      ) : plan === null ? (
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
          <Text variant="meta" style={styles.skipDetail}>
            Nothing has uploaded yet. Start the upload below, then keep this tab open until it finishes.
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
              {importPercent(upload.completed, upload.total)}%
            </Text>
          </View>
          <ImportProgress completed={upload.completed} total={upload.total} />
        </Notice>
      ) : null}

      {upload.kind === "failed" ? (
        <View>
          <FormError headline="The folder upload paused." next={upload.message} style={styles.notice} />
          <Notice style={styles.notice}>
            <Text variant="check" role="status">
              Paused at {upload.completed} of {upload.total} files · {importPercent(upload.completed, upload.total)}%
            </Text>
            <ImportProgress completed={upload.completed} total={upload.total} />
          </Notice>
        </View>
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
              label={upload.kind === "failed" ? "Resume upload" : "Start upload"}
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
    choiceBlock: { marginTop: 18 },
    choiceDetail: { marginTop: 5 },
    actions: {
      marginTop: 18,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    },
    notice: { marginTop: 14 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    progressTrack: {
      height: 7,
      marginTop: 9,
      overflow: "hidden",
      borderRadius: 99,
      backgroundColor: colors.line,
    },
    progressFill: { height: "100%", borderRadius: 99, backgroundColor: colors.accent },
    skipDetail: { marginTop: 7, color: colors.muted },
    okText: { color: colors.okText },
  });
