import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { StorageChoice } from "../../console/storage/StorageChoice";
import type { ConnectFormValues } from "../../console/storage/connect";
import { connectProgressLabel } from "../verify";
import type { ConnectState } from "../verify";
import type { ManagedOffer } from "../useManagedOffer";
import type { OnboardingController } from "../useOnboarding";
import { ManagedConfirm } from "./ManagedConfirm";
import { ManagedSettling } from "./ManagedSettling";

/**
 * Step 2 — where the notes live.
 *
 * The connect form is the console's, reused rather than rebuilt: the SSRF host
 * rules, the addressing question that only appears when it is genuinely a
 * question, and the copy about what happens to the secret are all things that
 * would rot in a second copy.
 *
 * What this step adds is the things onboarding needs and the console does not.
 * First, the probe's progress — `bindStorage` returns as soon as the row is
 * written, so "connected" is a thing that happens a moment later, on the
 * subscription, and a first-run screen that just went quiet at that point would
 * read as broken. Second, the way out: **"I'll do this later" is a real
 * answer.** A context with no binding is a state the schema supports, and a
 * credential form is a hostile place to trap somebody thirty seconds into their
 * first session — they may not have made the bucket yet.
 *
 * ## Managed storage, and the two screens behind it
 *
 * Somebody can either bring storage they control or ask Context to run it.
 * The managed path is only drawn where the deployment can
 * actually deliver that (`useManagedOffer`), and pressing it does not go
 * straight to Stripe — `ManagedConfirm` states the price, the billable unit
 * and the exit promise first, because an outward, irreversible step is owed a
 * screen that says all of it at once. Coming back from Stripe lands here too,
 * in `ManagedSettling`.
 */
export function StorageStep({ controller }: { controller: OnboardingController }) {
  return (
    <StorageStepBody
      connectState={controller.connectState}
      workspaceId={controller.claimed?.workspaceId ?? null}
      contextName={controller.claimed === null ? "this context" : `@${controller.claimed.slug}`}
      connect={controller.connect}
      managed={controller.managed}
      storageReady={controller.connectState.kind === "connected"}
      onSkip={controller.skipStorage}
      onContinuePast={controller.continuePastStorage}
    />
  );
}

/**
 * The step with its data already resolved — what the suite and the browser
 * fixture drive, exactly as `StorageChoiceBody` is.
 */
export function StorageStepBody({
  connectState,
  workspaceId,
  contextName,
  connect,
  managed,
  storageReady,
  onSkip,
  onContinuePast,
}: {
  connectState: ConnectState;
  workspaceId: string | null;
  contextName: string;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Absent where this deployment cannot provide managed storage. */
  managed: ManagedOffer | null;
  storageReady: boolean;
  onSkip: () => void;
  onContinuePast: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const progress = connectProgressLabel(connectState);
  const busy = connectState.kind === "binding" || connectState.kind === "verifying";

  if (managed !== null && managed.mode === "settling") {
    return (
      <ManagedSettling
        state={{
          paid: managed.paid,
          storageReady,
          slow: managed.slow,
          failure: managed.provisionFailure,
        }}
        contextName={contextName}
        onUseOwnStorage={managed.back}
        onCarryOn={onSkip}
        onRetry={managed.retry}
      />
    );
  }

  if (managed !== null && managed.mode === "confirm" && managed.status !== null) {
    return (
      <ManagedConfirm
        status={managed.status}
        contextName={contextName}
        state={managed.session}
        failure={managed.failure}
        onToggle={managed.toggle}
        onContinue={managed.proceed}
        onBack={managed.back}
      />
    );
  }

  return (
    <View>
      {/*
        Deliberately short, and deliberately not a second pitch: the form below
        already opens with what a bucket is for and what happens to the secret.
        Repeating it here was the first thing that read as filler on screen.
      */}
      <Text variant="rowSub" style={styles.lede}>
        Your name is claimed. Context keeps your notes as plain Markdown files — this is
        where those files go.
      </Text>

      {connectState.kind === "connected" ? (
        <Notice tone="ok">
          <Text variant="check" role="status" style={styles.okText}>
            Your storage is connected — we can list it and write to it.
          </Text>
        </Notice>
      ) : (
        <StorageChoice
          workspaceId={workspaceId}
          connect={connect}
          dropboxResumeTo="onboarding"
          managed={
            managed === null || !managed.available
              ? undefined
              : { price: managed.price, onChoose: managed.choose }
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
            testID="welcome-storage-continue"
          />
        ) : null}
        {connectState.kind === "connected" ? null : (
          <Button
            label="I'll do this later"
            variant="ghost"
            disabled={busy}
            onPress={onSkip}
            testID="welcome-storage-skip"
          />
        )}
      </View>

      {/*
        One line rather than the card this used to be. The card said the same
        thing the button beside it says, at four times the size — which is the
        ceremony this flow is supposed to be free of.
      */}
      {connectState.kind === "connected" ? null : (
        <Text variant="foot" style={styles.later}>
          No storage yet? Skipping is fine and nothing here expires. The console shows that
          storage is not connected, with this form waiting behind it.
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
