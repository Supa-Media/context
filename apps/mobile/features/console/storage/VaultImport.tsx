import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Check } from "../../design/components/Field";
import { ChoiceGroup, FormError, Notice, TextField } from "../../design/components/Input";
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
  | { kind: "clearing"; completed: number; total: number; phase: "counting" | "deleting" }
  | { kind: "uploading"; completed: number; total: number }
  | { kind: "complete"; created: number; skipped: number }
  | {
      kind: "failed";
      stage: "counting" | "clearing" | "uploading";
      message: string;
      completed: number;
      total: number;
    };

interface VaultJobStatus {
  jobId: Id<"vaultImportJobs">;
  strategy: VaultImportStrategy;
  status: "active" | "paused" | "complete";
  totalFiles: number;
  completedFiles: number;
  createdFiles: number;
  skippedFiles: number;
  completedBatches?: number[];
  replacement?: {
    phase: "counting" | "deleting" | "uploading";
    totalObjects: number;
    deletedObjects: number;
  };
}

function importPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function ImportProgress({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
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
  const clearReplacementBatch = useAction(api.functions.files.clearVaultImportBatch);
  const startJob = useMutation(api.functions.files.startVaultImport);
  const pauseJob = useMutation(api.functions.files.pauseVaultImport);
  const existingJob = useQuery(api.functions.files.latestVaultImportJob, {
    workspaceId,
  });
  const resetPrivacy = useAction(api.functions.files.resetPrivacy);
  return (
    <VaultImportBody
      workspaceId={workspaceId}
      existingData={existingData}
      existingJob={existingJob ?? undefined}
      startJob={startJob}
      importBatch={importBatch}
      clearReplacementBatch={clearReplacementBatch}
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
  clearReplacementBatch,
  pauseJob,
  resetPrivacy,
  onSkip,
  onComplete,
  testIDPrefix = "vault",
}: {
  workspaceId: Id<"workspaces">;
  existingData?: boolean;
  existingJob?: Omit<VaultJobStatus, "jobId"> & {
    jobId?: Id<"vaultImportJobs">;
  };
  startJob: (args: {
    workspaceId: Id<"workspaces">;
    strategy: VaultImportStrategy;
    sourceFingerprint: string;
    totalFiles: number;
    totalBytes: number;
    totalBatches: number;
    confirmation?: string;
  }) => Promise<VaultJobStatus>;
  importBatch: (args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
    sourceFingerprint: string;
    batchIndex: number;
    files: { path: string; bytes: ArrayBuffer; contentType: string }[];
  }) => Promise<VaultJobStatus>;
  clearReplacementBatch?: (args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
    sourceFingerprint: string;
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
    existingData ? (existingJob?.strategy ?? null) : "merge",
  );
  const [plan, setPlan] = useState<VaultPlan | null>(null);
  const [replaceConfirmation, setReplaceConfirmation] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickingUnavailable, setPickingUnavailable] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  const busy = picking || upload.kind === "uploading" || upload.kind === "clearing";
  const resumingConfirmedReplacement =
    strategy === "replace" && existingJob?.status !== undefined && existingJob.status !== "complete";
  const replacementConfirmed =
    strategy !== "replace" || replaceConfirmation === "I understand" || resumingConfirmedReplacement;

  useEffect(() => {
    if (strategy === null && existingJob?.strategy !== undefined)
      setStrategy(existingJob.strategy);
  }, [existingJob?.strategy, strategy]);

  const select = async () => {
    if (strategy === null) return;
    setPickingUnavailable(false);
    setPickError(null);
    setPicking(true);
    setPlan(null);
    setUpload({ kind: "idle" });
    try {
      const picked = await pickObsidianVault();
      if (picked.kind === "unavailable") {
        setPickingUnavailable(true);
        return;
      }
      if (picked.kind === "selected") {
        const nextPlan = vaultPlanForStrategy(
          planVaultFiles(picked.files),
          strategy,
        );
        if (nextPlan.files.length === 0) {
          setPickError(
            "No importable files were found in that folder. Choose a folder containing Markdown notes or attachments smaller than 4.5 MB.",
          );
          return;
        }
        setPlan(nextPlan);
      }
    } catch {
      setPickError(
        "Context could not read that folder. Choose it again to retry.",
      );
    } finally {
      setPicking(false);
    }
  };

  const start = async () => {
    if (plan === null || strategy === null || plan.files.length === 0 || busy)
      return;
    setUpload({ kind: "uploading", completed: 0, total: plan.files.length });
    let jobId: Id<"vaultImportJobs"> | undefined;
    let completed = 0;
    let total = plan.files.length;
    let failureStage: "counting" | "clearing" | "uploading" = "uploading";
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
        ...(strategy === "replace" ? { confirmation: "I understand" } : {}),
      });
      jobId = job.jobId;
      let latest = job;
      while (latest.replacement !== undefined && latest.replacement.phase !== "uploading") {
        failureStage = latest.replacement.phase === "counting" ? "counting" : "clearing";
        completed = latest.replacement.deletedObjects;
        total = latest.replacement.totalObjects;
        if (clearReplacementBatch === undefined) {
          throw new Error("Replacement clearing is unavailable.");
        }
        setUpload({
          kind: "clearing",
          phase: latest.replacement.phase,
          completed: latest.replacement.deletedObjects,
          total: latest.replacement.totalObjects,
        });
        latest = await clearReplacementBatch({
          workspaceId,
          jobId,
          sourceFingerprint,
        });
      }
      failureStage = "uploading";
      completed = latest.completedFiles;
      total = latest.totalFiles;
      setUpload({
        kind: "uploading",
        completed: latest.completedFiles,
        total: latest.totalFiles,
      });
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
        latest = await importBatch({
          workspaceId,
          jobId,
          sourceFingerprint,
          batchIndex,
          files,
        });
        completed = latest.completedFiles;
        total = latest.totalFiles;
        setUpload({
          kind: "uploading",
          completed: latest.completedFiles,
          total: latest.totalFiles,
        });
      }
      // A fresh import replaces onboarding's scaffold step, so it needs the
      // all-private access map that step would have created. Settings imports
      // leave a workspace's existing access map alone.
      if (strategy !== "replace" && resetPrivacy !== undefined) await resetPrivacy({ workspaceId });
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
        stage: failureStage,
        completed,
        total,
        message:
          failureStage !== "uploading"
            ? "The replacement stopped safely. Choose Resume now, or reselect the same folder later; Context will continue clearing from the saved count before it uploads."
            : "The upload stopped. Choose Resume upload now, or reselect the same folder later; Context will continue after the last completed batch.",
      });
    }
  };

  return (
    <View testID={`${testIDPrefix}-import`}>
      <Text variant="rowTitle">Import Markdown</Text>
      <Text variant="rowSub" style={styles.lede}>
        Have an Obsidian vault or existing Markdown notes? Add the folder here;
        its Markdown, folders, and attachments stay together.
      </Text>

      <View style={styles.promises}>
        {strategy === "replace" ? (
          <Check tone="warn">The selected folder becomes this bucket's new contents.</Check>
        ) : (
          <Check tone="ok">Existing files stay unchanged.</Check>
        )}
        <Check tone="ok">
          Obsidian settings, plugin data, trash, and Git files are skipped.
        </Check>
      </View>

      <Card style={styles.workflow}>
        {existingData &&
        !(existingJob !== undefined && existingJob.status !== "complete") ? (
          <ChoiceGroup
            label="How should these notes be added?"
            hint="Merge and folder imports preserve existing files. Replacement permanently clears the bucket first."
            options={[
              {
                value: "merge",
                label: "Merge without replacing",
                detail:
                  "Keep the vault's current folder paths and skip name collisions.",
              },
              {
                value: "folder",
                label: "Keep it in its own folder",
                detail: "Put everything under Imports / Vault name.",
              },
              {
                value: "replace",
                label: "Replace everything",
                detail: "Permanently remove every existing file in this bucket, then upload this folder.",
              },
            ]}
            value={strategy}
            disabled={busy}
            onChange={(value) => {
              setStrategy(value);
              setPlan(null);
              setPickError(null);
              setUpload({ kind: "idle" });
              setReplaceConfirmation("");
            }}
            testID={testIDPrefix}
          />
        ) : null}

        {strategy === "replace" && !resumingConfirmedReplacement && upload.kind === "idle" ? (
          <Notice tone="warn" style={styles.notice}>
            <Text variant="rowTitle">This permanently deletes every existing file in this bucket.</Text>
            <Text variant="check" style={styles.dangerDetail}>
              Notes, attachments, access settings, audit files, and Context system files are removed before the selected folder uploads. Context cannot undo this. Your storage provider may retain older versions if bucket versioning is enabled. Ask collaborators and sync tools to stop editing until it finishes.
            </Text>
            <TextField
              label="Type I understand to continue"
              value={replaceConfirmation}
              onChangeText={setReplaceConfirmation}
              autoCapitalize="none"
              autoCorrect={false}
              testID={`${testIDPrefix}-replace-confirmation`}
              containerStyle={styles.confirmation}
            />
          </Notice>
        ) : null}

        {existingJob !== undefined &&
        existingJob.status !== "complete" &&
        upload.kind === "idle" ? (
          <View style={styles.stepBlock}>
            <Text variant="rowTitle">Resume this import</Text>
            <Text variant="check" role="status" style={styles.stepDetail}>
              {existingJob.replacement?.phase === "counting"
                ? "Counting the existing bucket will resume."
                : existingJob.replacement?.phase === "deleting"
                  ? `${existingJob.replacement.deletedObjects} of ${existingJob.replacement.totalObjects} existing files removed · ${importPercent(existingJob.replacement.deletedObjects, existingJob.replacement.totalObjects)}%`
                  : `${existingJob.completedFiles} of ${existingJob.totalFiles} files finished · ${importPercent(existingJob.completedFiles, existingJob.totalFiles)}%`}
            </Text>
            {existingJob.replacement?.phase === "counting" ? null : (
              <ImportProgress
                completed={existingJob.replacement?.phase === "deleting"
                  ? existingJob.replacement.deletedObjects
                  : existingJob.completedFiles}
                total={existingJob.replacement?.phase === "deleting"
                  ? existingJob.replacement.totalObjects
                  : existingJob.totalFiles}
              />
            )}
            <Text variant="meta" style={styles.skipDetail}>
              Choose the same vault to resume. Completed batches will not upload
              again.
            </Text>
          </View>
        ) : null}

        {strategy !== null && replacementConfirmed && plan === null && upload.kind === "idle" ? (
          <View style={styles.stepBlock}>
            <Text variant="eyebrow">Choose your folder</Text>
            {picking ? (
              <View style={styles.progressRow} role="status">
                <ActivityIndicator color={colors.text2} size="small" />
                <Text variant="check">Reading the selected folder…</Text>
              </View>
            ) : (
              <View style={styles.actions}>
                <Button
                  label="Choose a vault or notes folder"
                  variant="mini"
                  onPress={() => void select()}
                  testID={`${testIDPrefix}-choose`}
                />
                {onSkip === undefined ? null : (
                  <Button
                    label="No, start fresh"
                    variant="ghost"
                    onPress={onSkip}
                    testID={`${testIDPrefix}-skip`}
                  />
                )}
              </View>
            )}
          </View>
        ) : null}

        {plan !== null && upload.kind === "idle" ? (
          <View style={styles.stepBlock}>
            <Text variant="rowTitle">Ready to upload</Text>
            <Text variant="check" role="status" style={styles.stepDetail}>
              {plan.files.length} {plan.files.length === 1 ? "file" : "files"} ·{" "}
              {formatVaultBytes(plan.totalBytes)}
              {plan.skipped > 0 ? ` · ${plan.skipped} safely skipped` : ""}
            </Text>
            <Text variant="meta" style={styles.skipDetail}>
              {strategy === "folder"
                ? `Destination: Imports / ${plan.rootName}`
                : strategy === "replace"
                  ? "Destination: replaces every file in this bucket"
                  : "Destination: existing folder paths"}
            </Text>
            <Notice tone="warn" style={styles.notice}>
              <Text variant="check">
                Keep this tab open during the upload. If it closes, come back
                and choose the same folder to resume.
              </Text>
            </Notice>
          </View>
        ) : null}

        {pickingUnavailable ? (
          <Notice tone="warn" style={styles.notice}>
            <Text variant="check">
              Folder upload is available in the Context Mac app and web console.
              Open either one to preserve the folder structure.
            </Text>
          </Notice>
        ) : null}

        {pickError !== null ? (
          <FormError
            headline="That folder is not ready to import."
            next={pickError}
            style={styles.notice}
          />
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
            <Text variant="meta" style={styles.skipDetail}>
              Keep this tab open. If the connection fails, this progress is
              saved.
            </Text>
          </Notice>
        ) : null}

        {upload.kind === "clearing" ? (
          <Notice tone="warn" style={styles.notice}>
            <View style={styles.progressRow}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="check" role="status">
                {upload.phase === "counting"
                  ? "Counting existing bucket files…"
                  : `Removing ${upload.completed} of ${upload.total} existing files · ${importPercent(upload.completed, upload.total)}%`}
              </Text>
            </View>
            {upload.phase === "deleting" ? (
              <ImportProgress completed={upload.completed} total={upload.total} />
            ) : null}
            <Text variant="meta" style={styles.skipDetail}>
              Keep this tab open. If the connection fails, deletion progress is saved and can resume.
            </Text>
          </Notice>
        ) : null}

        {upload.kind === "failed" ? (
          <View>
            <FormError
              headline="The folder upload paused."
              next={upload.message}
              style={styles.notice}
            />
            <Notice style={styles.notice}>
              <Text variant="check" role="status">
                {upload.stage === "counting"
                  ? "Paused while counting existing bucket files."
                  : `Paused at ${upload.completed} of ${upload.total} ${upload.stage === "clearing" ? "existing files removed" : "files uploaded"} · ${importPercent(upload.completed, upload.total)}%`}
              </Text>
              {upload.stage === "counting" ? null : (
                <ImportProgress
                  completed={upload.completed}
                  total={upload.total}
                />
              )}
            </Notice>
          </View>
        ) : null}

        {upload.kind === "complete" ? (
          <Notice tone="ok" style={styles.notice}>
            <Text variant="check" role="status" style={styles.okText}>
              Import complete. {upload.created} {upload.created === 1 ? "file" : "files"} uploaded
              {upload.skipped > 0
                ? `, ${upload.skipped} already there or skipped`
                : ""}
              .
            </Text>
          </Notice>
        ) : null}

        {plan !== null ? (
          <View style={styles.actions}>
            {upload.kind === "complete" && onComplete !== undefined ? (
              <Button
                label="Continue"
                variant="white"
                onPress={onComplete}
                testID={`${testIDPrefix}-continue`}
              />
            ) : upload.kind === "complete" ? null : busy ? null : (
              <Button
                label={
                  upload.kind === "failed"
                    ? upload.stage !== "uploading"
                      ? "Resume replacement"
                      : "Resume upload"
                    : `Upload ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"}`
                }
                variant="white"
                disabled={plan.files.length === 0}
                onPress={() => void start()}
                testID={`${testIDPrefix}-upload`}
              />
            )}
            {!busy && upload.kind !== "complete" ? (
              <Button
                label="Choose another folder"
                variant="ghost"
                onPress={() => void select()}
              />
            ) : null}
          </View>
        ) : null}
      </Card>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { marginTop: 6, lineHeight: leading(12.5, 1.7) },
    promises: { gap: 7, marginTop: 14 },
    workflow: { marginTop: 18 },
    stepBlock: { marginTop: 18 },
    stepDetail: { marginTop: 8 },
    actions: {
      marginTop: 10,
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
    progressFill: {
      height: "100%",
      borderRadius: 99,
      backgroundColor: colors.accent,
    },
    skipDetail: { marginTop: 7, color: colors.muted },
    okText: { color: colors.okText },
    confirmation: { marginTop: 14 },
    dangerDetail: { marginTop: 8 },
  });
