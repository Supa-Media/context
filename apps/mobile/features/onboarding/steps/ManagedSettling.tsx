import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Card, Row } from "../../design/components/Card";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { leading, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * Back from Stripe, in a first run, while the rest of it happens.
 *
 * ## The three properties this screen is judged on
 *
 * Somebody has just been charged and has nothing yet. So:
 *
 * 1. **It never says "failed".** Nothing has failed. The payment succeeded and
 *    a webhook is on its way; delivery is at-least-once and out of order, so
 *    "not yet" is the ordinary case rather than a fault.
 * 2. **It never spins without a sentence.** A spinner alone is the screen a
 *    person reads as broken, and this is the worst possible moment for that.
 * 3. **It holds the hand-off until storage answers.** Cloudflare may need up to
 *    two minutes to propagate a new key, so leaving early would turn a normal
 *    wait into a red storage screen elsewhere in the app.
 *
 * ## Named steps, not a bar
 *
 * A bar implies a percentage, and there is no honest one here: the wait is a
 * webhook that arrives when it arrives. Naming the steps says what is
 * happening, which is what somebody who has just paid is actually asking.
 *
 * ## Three outcomes, and they are not the same screen
 *
 * **Waiting** is the ordinary case. **Slow** is the same wait once "a few
 * seconds" has stopped being true — different words and the same spinner.
 * **Failed** is an answer rather than a wait: the
 * control plane says provisioning will not finish, and the screen says the
 * payment and the notes are safe, that a retry cannot duplicate anything, and
 * offers the free path out.
 *
 * The distinction is load-bearing. Before there was a failure signal this
 * screen could only ever say "still working", so somebody whose bucket was
 * never going to appear sat in front of a spinner until they gave up.
 */
export interface ManagedSettlingState {
  /** The plan has turned active — the webhook landed. */
  paid: boolean;
  /** Storage exists and answers. */
  storageReady: boolean;
  /** Long enough that "a few seconds" has stopped being true. */
  slow: boolean;
  /**
   * Provisioning reported a failure, with our own code for it.
   *
   * Distinct from `slow`: a wait that has gone on too long is a wait, and this
   * is an answer. Before the control plane could tell them apart this screen
   * could only ever say "still working", and somebody whose bucket was never
   * going to appear sat in front of a spinner.
   */
  failure?: { title: string; body: string; canRetry: boolean };
}

export function ManagedSettling({
  state,
  contextName,
  onUseOwnStorage,
  onRetry,
}: {
  state: ManagedSettlingState;
  contextName: string;
  /** The free path out, which is always available and never a punishment. */
  onUseOwnStorage: () => void;
  /** Another go at making the bucket. Safe by construction — see the action. */
  onRetry: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  if (state.failure !== undefined) {
    return (
      <View>
        <FormError
          headline={state.failure.title}
          next={state.failure.body}
          style={styles.failure}
        />
        <Row style={styles.actions}>
          {state.failure.canRetry ? (
            <Button
              label="Try again"
              variant="decision"
              onPress={onRetry}
              testID="managed-settling-retry"
            />
          ) : null}
          <Button
            label="Connect storage I own"
            variant={state.failure.canRetry ? "ghost" : "decision"}
            onPress={onUseOwnStorage}
            testID="managed-settling-own"
          />
        </Row>
        <Text variant="foot" style={styles.foot}>
          If a second attempt fails too, get in touch and we will set it up by hand. You
          should not pay for storage you are not using — tell us if you connect your own
          and we will stop the subscription.
        </Text>
      </View>
    );
  }

  const steps: Array<{ label: string; state: "done" | "working" | "waiting" }> = [
    {
      label: state.paid ? "Payment confirmed" : "Confirming your payment",
      state: state.paid ? "done" : "working",
    },
    {
      label: "Creating your storage",
      state: state.storageReady ? "done" : state.paid ? "working" : "waiting",
    },
    {
      label: "Laying out your folders",
      state: state.storageReady ? "working" : "waiting",
    },
  ];

  return (
    <View>
      <View style={styles.head}>
        <Pill tone="ok" leading={<Dot tone="ok" />}>
          Paid
        </Pill>
        <Text variant="rowTitle" role="status">
          {state.slow ? "Still working" : "Payment received"}
        </Text>
      </View>
      <Text variant="rowSub" style={styles.lede}>
        {state.slow
          ? "Still creating and verifying your storage; this can take up to 2 minutes. " +
            "Keep this page open until we confirm it is ready."
          : `Setting up storage for ${contextName}; this can take up to 2 minutes, so keep this page open until it is ready.`}
      </Text>

      <Card style={styles.card}>
        <View style={styles.steps} testID="managed-settling-steps">
          {steps.map((step) => (
            <View key={step.label} style={styles.stepRow}>
              {step.state === "working" ? (
                <ActivityIndicator size="small" color={colors.text2} style={styles.mark} />
              ) : (
                <View style={styles.mark}>
                  <Dot tone={step.state === "done" ? "ok" : "neutral"} />
                </View>
              )}
              <Text
                variant="rowSub"
                style={[styles.stepLabel, step.state === "waiting" && styles.waiting]}
              >
                {step.label}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {state.slow ? (
        <View>
          <Notice style={styles.card} testID="managed-settling-slow">
            <Text variant="rowSub">
              Your payment is safe and nothing has been lost; we are keeping this screen
              here until the bucket itself confirms that it is usable.
            </Text>
          </Notice>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    lede: { marginTop: space.x3, lineHeight: leading(12.5, 1.7) },
    card: { marginTop: space.x4 },
    steps: { gap: space.x3 },
    stepRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    mark: { width: 16, alignItems: "center" },
    stepLabel: { flex: 1, minWidth: 0 },
    waiting: { color: colors.muted },
    actions: { marginTop: space.x4, gap: space.x3, flexWrap: "wrap" },
    failure: { marginBottom: space.x2 },
    foot: { marginTop: space.x4, lineHeight: leading(12.5, 1.7), color: colors.muted },
  });
