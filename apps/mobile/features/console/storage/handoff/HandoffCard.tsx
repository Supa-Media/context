import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Row } from "../../../design/components/Card";
import { FormError } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { Confirm } from "../../files/Dialogs";
import type { ConsoleStorage } from "../../types";
import {
  MOVED,
  STILL_LIVE,
  STOP,
  TAKE_IT_WITH_YOU,
  describeHandoffFailure,
  existingFilesLine,
  failureHeadline,
  retainedLine,
  stoppedLine,
} from "./copy";
import { handoffSteps, type HandoffStep } from "./steps";
import { ExistingFilesChoice, type ExistingFilesAnswer } from "./ExistingFilesChoice";

/**
 * The way out of managed storage, in Settings › Storage.
 *
 * One card with one job per state: offer the move and the download while the
 * workspace is on Context's storage; show the five steps while it moves, with
 * a way to stop it; say plainly why a move paused and which files did it; and,
 * for a week after it finished, offer the way back. The download is here in
 * every managed state, not only the idle one, because taking your files is
 * never behind anything (`CLAUDE.md`, non-negotiable #1).
 *
 * Draws nothing for a workspace that was never on managed storage.
 */
export function HandoffCard({
  storage,
  owner,
  onMove,
  onStop,
  onDownload,
  onSwitchBack,
  onChooseExisting,
  now = Date.now(),
}: {
  storage: ConsoleStorage;
  /** Whether this viewer may move storage. Absent actions mean no controls. */
  owner: boolean;
  onMove: () => void;
  onStop?: () => Promise<unknown>;
  onDownload?: () => void;
  onSwitchBack?: () => void;
  /** Answers a bucket that already has files: merge, or start fresh. */
  onChooseExisting?: (answer: ExistingFilesAnswer) => Promise<unknown>;
  now?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);

  const retained =
    storage.managed !== true &&
    storage.managedRetainedUntil !== undefined &&
    storage.managedRetainedUntil > now;
  if (storage.managed !== true && !retained) return null;

  if (retained) {
    return (
      <Card testID="storage-handoff-done" style={styles.card}>
        <Text variant="rowTitle">{MOVED.title}</Text>
        <Text variant="rowSub" style={styles.line}>
          {MOVED.plain}
        </Text>
        <Text variant="rowSub" style={styles.line} testID="storage-handoff-retained">
          {retainedLine(storage.managedRetainedUntil!)}
        </Text>
        {owner && onSwitchBack !== undefined ? (
          <Row style={styles.actions}>
            <Button label={MOVED.switchBack} onPress={onSwitchBack} testID="storage-switch-back" />
          </Row>
        ) : null}
      </Card>
    );
  }

  const download =
    onDownload === undefined ? null : (
      <Button label={TAKE_IT_WITH_YOU.download} onPress={onDownload} testID="storage-download-all" />
    );

  const stop = async () => {
    setConfirming(false);
    if (onStop === undefined) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  if (storage.handoffStatus === "copying") {
    const steps = handoffSteps({
      phase: storage.handoffPhase,
      claimed: storage.handoffClaimed,
      total: storage.handoffObjectsTotal,
      processed: storage.handoffObjectsProcessed,
      readyToSwitch: storage.handoffReadyToSwitch,
    });
    const existing = existingFilesLine(storage.handoffExistingFiles);
    return (
      <Card testID="storage-handoff-moving" style={styles.card}>
        <Text variant="rowTitle">
          {storage.handoffBucket === undefined
            ? "Moving to your bucket"
            : `Moving to ${storage.handoffBucket}`}
        </Text>
        {existing === null ? null : (
          <Text variant="rowSub" style={styles.line} testID="storage-handoff-existing">
            {existing}
          </Text>
        )}
        <View style={styles.steps} role="status" testID="storage-handoff-progress">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} styles={styles} />
          ))}
        </View>
        <Text variant="rowSub" style={styles.line}>
          {`${STILL_LIVE} You can close this page; the move carries on.`}
        </Text>
        <Row style={styles.actions}>
          {owner && storage.handoffReadyToSwitch !== true && onStop !== undefined ? (
            <Button
              label={stopping ? "Stopping…" : STOP.button}
              disabled={stopping}
              onPress={() => setConfirming(true)}
              testID="storage-handoff-stop"
            />
          ) : null}
          {download}
        </Row>
        {confirming ? (
          <Confirm
            title={STOP.title}
            body={STOP.body}
            confirmLabel={STOP.button}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void stop()}
          />
        ) : null}
      </Card>
    );
  }

  if (
    storage.handoffStatus === "failed" &&
    (storage.handoffErrorCode === "DESTINATION_NOT_EMPTY" ||
      storage.handoffErrorCode === "DESTINATION_NOT_CLEARED") &&
    owner &&
    onChooseExisting !== undefined &&
    storage.handoffBucket !== undefined
  ) {
    return (
      <Card testID="storage-handoff-failed" style={styles.card}>
        <FormError
          headline={failureHeadline(storage.handoffErrorCode, 0)}
          next={describeHandoffFailure(storage.handoffErrorCode)}
        />
        <ExistingFilesChoice
          bucket={storage.handoffBucket}
          onChoose={onChooseExisting}
          onOther={onMove}
        />
        {download === null ? null : <Row style={styles.actions}>{download}</Row>}
      </Card>
    );
  }

  if (storage.handoffStatus === "failed" && storage.handoffErrorCode !== "CANCELLED") {
    const failed = storage.handoffFailedKeys ?? [];
    return (
      <Card testID="storage-handoff-failed" style={styles.card}>
        <FormError
          headline={failureHeadline(storage.handoffErrorCode, failed.length)}
          next={describeHandoffFailure(storage.handoffErrorCode)}
        />
        {failed.length > 0 ? (
          <View style={styles.failedList} testID="storage-handoff-failed-files">
            {failed.map((key) => (
              <Text key={key} variant="mono">
                {key}
              </Text>
            ))}
          </View>
        ) : null}
        <Row style={styles.actions}>
          {owner ? <Button label="Retry" onPress={onMove} testID="storage-handoff" /> : null}
          {download}
        </Row>
      </Card>
    );
  }

  return (
    <Card testID="storage-handoff-offer" style={styles.card}>
      <Text variant="rowTitle">{TAKE_IT_WITH_YOU.title}</Text>
      {storage.handoffStatus === "failed" ? (
        <Text variant="rowSub" style={styles.line} role="status" testID="storage-handoff-stopped">
          {stoppedLine(storage.handoffBucket)}
        </Text>
      ) : null}
      <Text variant="rowSub" style={styles.line}>
        {owner ? TAKE_IT_WITH_YOU.body : TAKE_IT_WITH_YOU.notOwner}
      </Text>
      <Row style={styles.actions}>
        {owner ? (
          <Button label={TAKE_IT_WITH_YOU.move} onPress={onMove} testID="storage-handoff" />
        ) : null}
        {download}
      </Row>
    </Card>
  );
}

function StepRow({ step, styles }: { step: HandoffStep; styles: ReturnType<typeof makeStyles> }) {
  const mark = step.state === "done" ? "✓" : step.state === "current" ? "●" : "○";
  return (
    <View style={styles.step} testID={`storage-handoff-step-${step.key}`}>
      <View style={styles.stepHead}>
        <Text variant="rowSub" style={step.state === "done" ? styles.done : undefined}>
          {mark}
        </Text>
        <Text variant={step.state === "current" ? "rowTitle" : "rowSub"}>{step.label}</Text>
      </View>
      {step.progress === undefined ? null : (
        <View style={styles.barRow}>
          <View
            style={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={step.progress.total}
            aria-valuenow={step.progress.done}
          >
            <View
              style={[
                styles.fill,
                { width: `${Math.round((step.progress.done / step.progress.total) * 100)}%` },
              ]}
            />
          </View>
          <Text variant="meta">
            {`${step.progress.done.toLocaleString("en-US")} of ${step.progress.total.toLocaleString("en-US")}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: 12 },
    line: { marginTop: 6 },
    actions: { marginTop: 14, flexWrap: "wrap", gap: 8 },
    steps: { marginTop: 12, gap: 10 },
    step: { gap: 6 },
    stepHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    done: { color: colors.ok },
    barRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 20 },
    track: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.surface3,
      overflow: "hidden",
    },
    fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
    failedList: { marginTop: 10, gap: 4 },
  });
