/**
 * The Estate tab's "Managed storage encryption" card (Boards 1 and 2).
 *
 * It sits at the top of Estate because Estate is already where managed and
 * customer storage are counted; there is no sixth tab. Every sentence comes
 * from `./encryption`, which is where the states are decided and tested; this
 * file lays them out and wires the five staff mutations.
 *
 * The status is read through `useQueries`, so a failed read is a value and
 * the card says "Couldn't load" instead of taking the tab down with it.
 * "Try again" remounts the subscription.
 */

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Pill, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { Panel, Skeleton, usePanelPad } from "./AdminKit";
import { CompositionBar } from "./Charts";
import { EncryptionStartDialog } from "./EncryptionStartDialog";
import { EncryptionWorkspaces } from "./EncryptionWorkspaces";
import { compositionOf } from "./report";
import { messageFor } from "./SecretDialogs";
import {
  ACTION_LABELS,
  CARD_TITLE,
  LOAD_FAILED,
  encryptionCardView,
  failureLine,
  type RolloutStatus,
} from "./encryption";

export function EncryptionCard() {
  const [attempt, setAttempt] = useState(0);
  return <EncryptionCardBody key={attempt} onRetry={() => setAttempt((count) => count + 1)} />;
}

function EncryptionCardBody({ onRetry }: { onRetry: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const spec = useMemo<RequestForQueries>(
    () => ({ status: { query: api.functions.managedEncryption.rolloutStatus, args: {} } }),
    [],
  );
  const status = useQueries(spec).status as RolloutStatus | Error | undefined;

  if (status === undefined) {
    return (
      <Panel testID="admin-encryption" style={styles.panel}>
        <CardHead />
        <View aria-busy testID="admin-encryption-loading">
          <Skeleton width="100%" height={8} />
          <Skeleton width={180} height={12} style={styles.gap} />
        </View>
      </Panel>
    );
  }
  if (status instanceof Error) {
    return (
      <Panel testID="admin-encryption" style={styles.panel}>
        <CardHead />
        <Text variant="check" testID="admin-encryption-error">
          {LOAD_FAILED}
        </Text>
        <View style={styles.actions}>
          <Button label="Try again" onPress={onRetry} testID="admin-encryption-retry-load" />
        </View>
      </Panel>
    );
  }
  return <RolloutCard status={status} />;
}

function CardHead({ pill }: { pill?: { label: string; tone: "ok" | "warn" | "crit" | "neutral" } }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.head}>
      <Text variant="rowTitle" role="heading" aria-level={2}>
        {CARD_TITLE}
      </Text>
      {pill ? (
        <Pill tone={pill.tone} testID="admin-encryption-state">
          {pill.label}
        </Pill>
      ) : null}
    </View>
  );
}

type Step = { kind: "idle" } | { kind: "pausing"; reason: string } | { kind: "stopping" } | { kind: "starting" };

function RolloutCard({ status }: { status: RolloutStatus }) {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  const view = encryptionCardView(status);
  const pause = useMutation(api.functions.managedEncryption.pauseRollout);
  const resume = useMutation(api.functions.managedEncryption.resumeRollout);
  const retry = useMutation(api.functions.managedEncryption.retryWorkspace);
  const stop = useMutation(api.functions.managedEncryption.stopStartingNew);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await work();
      setStep({ kind: "idle" });
    } catch (caught) {
      setError(messageFor(caught, "That didn't work. Try again."));
    } finally {
      setBusy(null);
    }
  }

  function press() {
    switch (view.action) {
      case "start":
        setStep({ kind: "starting" });
        return;
      case "pause":
        setStep({ kind: "pausing", reason: "" });
        return;
      case "stopNew":
        setStep({ kind: "stopping" });
        return;
      case "resume":
      case "resumeOthers":
        void run("resume", () => resume({}));
        return;
    }
  }

  const segments = view.bar ? compositionOf(view.bar) : null;

  return (
    <Panel testID="admin-encryption" style={styles.panel}>
      <CardHead pill={view.pill} />
      {view.summary ? (
        <Text variant="check" style={styles.summary} testID="admin-encryption-summary">
          {view.summary}
        </Text>
      ) : null}

      {segments ? (
        <View style={styles.gap}>
          <CompositionBar segments={segments} empty="Nothing started yet." testID="admin-encryption-bar" />
        </View>
      ) : null}
      {view.figures ? (
        <View style={styles.figures}>
          {view.figures.map((figure) => (
            <Text key={figure} variant="meta">
              {figure}
            </Text>
          ))}
        </View>
      ) : null}

      {view.failed.map((workspace) => (
        <View key={workspace.workspaceId} style={styles.failedRow} testID={`admin-encryption-failed-${workspace.slug}`}>
          <View style={styles.grow}>
            <Text variant="rowTitle">@{workspace.slug}</Text>
            <Text variant="meta">{failureLine(workspace.errorCode)}</Text>
          </View>
          <Button
            label={busy === workspace.workspaceId ? "Retrying…" : "Retry"}
            disabled={busy !== null}
            onPress={() =>
              void run(workspace.workspaceId, () =>
                retry({ workspaceId: workspace.workspaceId as Id<"workspaces"> }),
              )
            }
            testID={`admin-encryption-retry-${workspace.slug}`}
          />
        </View>
      ))}

      {step.kind === "pausing" ? (
        <View style={styles.inline} testID="admin-encryption-pause-form">
          <TextField
            label="Why pause?"
            value={step.reason}
            onChangeText={(reason) => setStep({ kind: "pausing", reason: reason.replace(/\n/g, " ") })}
            hint="One line, shown to the next person who opens the console."
            autoFocus
            maxLength={200}
            testID="admin-encryption-pause-reason"
          />
          <View style={styles.actions}>
            <Button label="Cancel" onPress={() => setStep({ kind: "idle" })} />
            <Button
              label={busy === "pause" ? "Pausing…" : "Pause"}
              disabled={busy !== null || step.reason.trim().length === 0}
              onPress={() => void run("pause", () => pause({ reason: step.reason.trim() }))}
              testID="admin-encryption-pause-confirm"
            />
          </View>
        </View>
      ) : step.kind === "stopping" ? (
        <View style={styles.inline} testID="admin-encryption-stop-confirm">
          <Text variant="check">
            Encrypted workspaces stay encrypted, keep opening and keep encrypting new saves.
            Workspaces not yet started stay plain.
          </Text>
          <View style={styles.actions}>
            <Button label="Cancel" onPress={() => setStep({ kind: "idle" })} />
            <Button
              label={busy === "stop" ? "Stopping…" : "Stop starting new"}
              variant="danger"
              disabled={busy !== null}
              onPress={() => void run("stop", () => stop({}))}
              testID="admin-encryption-stop"
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            label={busy === "resume" ? "Resuming…" : ACTION_LABELS[view.action]}
            disabled={busy !== null}
            onPress={press}
            testID={`admin-encryption-${view.action}`}
          />
          {view.byline ? (
            <Text variant="meta" style={styles.grow} testID="admin-encryption-byline">
              {view.byline}
            </Text>
          ) : null}
        </View>
      )}

      {error ? (
        <Text variant="error" role="alert" style={styles.gap} testID="admin-encryption-action-error">
          {error}
        </Text>
      ) : null}

      {view.table && status.workspaces.length > 0 ? (
        <View style={[styles.table, { marginHorizontal: -pad.x, marginBottom: -pad.y }]}>
          <EncryptionWorkspaces workspaces={status.workspaces} />
        </View>
      ) : null}

      {step.kind === "starting" ? <EncryptionStartDialog onClose={() => setStep({ kind: "idle" })} /> : null}
    </Panel>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { minWidth: 0 },
    head: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x2,
      marginBottom: space.x3,
    },
    summary: { color: colors.text2 },
    gap: { marginTop: space.x3 },
    figures: { flexDirection: "row", flexWrap: "wrap", columnGap: space.x4, rowGap: space.x1, marginTop: space.x3 },
    failedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      marginTop: space.x3,
      paddingVertical: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    grow: { flex: 1, minWidth: 0 },
    inline: { marginTop: space.x4, gap: space.x3 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x3, marginTop: space.x4 },
    table: { marginTop: space.x4, borderTopWidth: 1, borderTopColor: colors.line },
  });
