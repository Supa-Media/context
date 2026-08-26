import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { ConnectForm } from "../../console/storage/ConnectForm";
import { connectProgressLabel } from "../verify";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 2 — the bucket.
 *
 * The connect form is the console's, reused rather than rebuilt: the SSRF host
 * rules, the addressing question that only appears when it is genuinely a
 * question, and the copy about what happens to the secret are all things that
 * would rot in a second copy.
 *
 * What this step adds is the two things onboarding needs and the console does
 * not. First, the probe's progress — `bindStorage` returns as soon as the row
 * is written, so "connected" is a thing that happens a moment later, on the
 * subscription, and a first-run screen that just went quiet at that point would
 * read as broken. Second, the way out: **"I'll do this later" is a real
 * answer.** A context with no binding is a state the schema supports, and a
 * credential form is a hostile place to trap somebody thirty seconds into their
 * first session — they may not have made the bucket yet.
 */
export function StorageStep({ controller }: { controller: OnboardingController }) {
  const { connectState } = controller;
  const progress = connectProgressLabel(connectState);
  const busy = connectState.kind === "binding" || connectState.kind === "verifying";

  return (
    <View>
      {/*
        Deliberately short, and deliberately not a second pitch: the form below
        already opens with what a bucket is for and what happens to the secret.
        Repeating it here was the first thing that read as filler on screen.
      */}
      <Text variant="rowSub" style={styles.lede}>
        Your name is claimed. This is the one thing Context needs from you — and it is the
        last step you have to do now.
      </Text>

      {connectState.kind === "connected" ? (
        <Notice tone="ok">
          <Text variant="check" role="status" style={styles.okText}>
            Your bucket is connected — we can list it and write to it.
          </Text>
        </Notice>
      ) : (
        <ConnectForm connect={controller.connect} />
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
            onPress={controller.continuePastStorage}
            testID="welcome-storage-continue"
          />
        ) : null}
        {connectState.kind === "connected" ? null : (
          <Button
            label="I'll do this later"
            variant="ghost"
            disabled={busy}
            onPress={controller.skipStorage}
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
          No bucket yet? Skipping is fine and nothing here expires. The console shows that
          storage is not connected, with this form waiting behind it.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  progress: { marginTop: 14 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  progressBody: { flex: 1, minWidth: 0 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  actions: { marginTop: 16, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  later: { marginTop: 14, lineHeight: leading(12.5, 1.7) },
});
