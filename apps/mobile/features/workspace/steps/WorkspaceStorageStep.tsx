import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { StorageChoice } from "../../console/storage/StorageChoice";
import type { ConnectFormValues } from "../../console/storage/connect";
import { ManagedConfirm } from "../../onboarding/steps/ManagedConfirm";
import { ManagedSettling } from "../../onboarding/steps/ManagedSettling";
import { connectProgressLabel, type ConnectState } from "../../onboarding/verify";
import type { ManagedOffer } from "../../onboarding/useManagedOffer";
import { storageLede, WORKSPACE_AFTER_PAY } from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 2 — the workspace's bucket.
 *
 * The connect form is the console's, reused rather than rebuilt, for the reason
 * `../../onboarding/steps/StorageStep` gives: the SSRF host rules, the
 * addressing question, and the copy about what happens to the secret would all
 * rot in a second copy.
 *
 * ## The one thing this says that the onboarding version does not
 *
 * **A storage binding belongs to a `workspaceId`, never a `userId`.** This
 * bucket is not the creator's own and is not shared with it: a workspace has
 * its own binding, its own credential envelope, and its own audit trail. People
 * arrive at this screen expecting to point the workspace at the bucket they
 * already connected, and it is worth one sentence to say that a separate bucket
 * is the design rather than an oversight — the whole point is that revoking a
 * workspace's credential leaves the creator's own untouched, and vice versa.
 *
 * ## No Dropbox here
 *
 * New Dropbox connections are not offered (owner, 2026-09-24); `StorageChoice`
 * only draws that card for a context already on Dropbox, and a workspace being
 * created has no binding yet.
 *
 * ## Storage we run leaves the flow
 *
 * The managed card is drawn here exactly as it is in first run — a workspace
 * is the billable unit, so there was never a reason for this step to be the
 * one place it could not be chosen. What differs is where paying lands:
 * `useCreateWorkspace` starts the checkout with `origin: "settings"`, so
 * Stripe returns to the workspace's own Premium section rather than to a flow
 * that lives in component state. `WORKSPACE_AFTER_PAY` is that sentence, on
 * the confirmation screen, before the press.
 */
export function WorkspaceStorageStep({
  controller,
}: {
  controller: CreateWorkspaceController;
}) {
  return (
    <WorkspaceStorageStepBody
      connectState={controller.connectState}
      workspaceId={controller.created?.workspaceId ?? null}
      slug={controller.created?.slug ?? "the workspace"}
      connect={controller.connect}
      managed={controller.managed}
      onSkip={controller.skipStorage}
      onContinuePast={controller.continuePastStorage}
    />
  );
}

/**
 * The step with its data already resolved — what the suite drives, exactly as
 * `StorageStepBody` is.
 */
export function WorkspaceStorageStepBody({
  connectState,
  workspaceId,
  slug,
  connect,
  managed,
  onSkip,
  onContinuePast,
}: {
  connectState: ConnectState;
  workspaceId: string | null;
  /** The claimed handle, or a stand-in before the claim has come back. */
  slug: string;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Absent where this deployment cannot provide managed storage. */
  managed: ManagedOffer | null;
  onSkip: () => void;
  onContinuePast: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const progress = connectProgressLabel(connectState);
  const busy = connectState.kind === "binding" || connectState.kind === "verifying";

  if (managed?.mode === "settling") {
    return <ManagedSettling
      state={{ paid: managed.paid, stagingFreeStorage: managed.status?.stagingFreeStorage,
        storageReady: connectState.kind === "connected", slow: managed.slow, failure: managed.provisionFailure }}
      contextName={`@${slug}`} onUseOwnStorage={managed.back} onRetry={managed.retry}
    />;
  }

  if (managed !== null && managed.mode === "confirm" && managed.status !== null) {
    return (
      <ManagedConfirm
        status={managed.status}
        contextName={`@${slug}`}
        state={managed.session}
        failure={managed.failure}
        afterPay={WORKSPACE_AFTER_PAY}
        onToggle={managed.toggle}
        onContinue={managed.proceed}
        onBack={managed.back}
      />
    );
  }

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {storageLede(slug)}
      </Text>

      {connectState.kind === "connected" ? (
        <Notice tone="ok">
          <Text variant="check" role="status" style={styles.okText}>
            The bucket is connected — we can list it and write to it.
          </Text>
        </Notice>
      ) : (
        <StorageChoice
          workspaceId={workspaceId}
          connect={connect}
          managed={
            managed === null || !managed.available
              ? undefined
              : { price: managed.price, stagingFreeStorage: managed.status?.stagingFreeStorage, onChoose: managed.choose }
          }
        />
      )}

      {progress ? (
        <Notice style={styles.progress}>
          <View style={styles.progressRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status" style={styles.progressBody}>
              {progress}
            </Text>
          </View>
        </Notice>
      ) : null}

      {connectState.kind === "failed" ? (
        <FormError
          headline={connectState.failure.headline}
          next={[connectState.failure.next, connectState.failure.detail]
            .filter(Boolean)
            .join(" ")}
          style={styles.progress}
        />
      ) : null}

      {connectState.kind === "timeout" ? (
        <Notice tone="warn" style={styles.progress}>
          <Text variant="check" role="status" style={styles.warnText}>
            {connectState.message}
          </Text>
        </Notice>
      ) : null}

      <View style={styles.actions}>
        {connectState.kind === "failed" || connectState.kind === "timeout" ? (
          <Button
            label="Carry on anyway"
            accessibilityLabel="Continue without a verified bucket"
            onPress={onContinuePast}
            testID="workspace-storage-continue"
          />
        ) : null}
        {connectState.kind === "connected" ? null : (
          <Button
            label="I'll do this later"
            variant="ghost"
            disabled={busy}
            onPress={onSkip}
            testID="workspace-storage-skip"
          />
        )}
      </View>

      {connectState.kind === "connected" ? null : (
        <Text variant="foot" style={styles.later}>
          Skipping is fine and nothing here expires — you can still invite people, and they
          will find the workspace empty until a bucket is connected from its settings. The
          name stays claimed for as long as the workspace does; deleting it from its own
          settings gives the name back.
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  progress: { marginTop: 14 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  progressBody: { flex: 1, minWidth: 0 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  actions: { marginTop: 16, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  later: { marginTop: 14, lineHeight: leading(12.5, 1.7) },
});
