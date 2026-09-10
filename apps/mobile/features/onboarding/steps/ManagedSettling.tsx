import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Card, Row } from "../../design/components/Card";
import { Notice } from "../../design/components/Input";
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
 * 3. **It gives permission to leave.** The work finishes on the server whether
 *    or not this tab is open, and saying so is the difference between waiting
 *    anxiously and going away.
 *
 * ## Named steps, not a bar
 *
 * A bar implies a percentage, and there is no honest one here: the wait is a
 * webhook that arrives when it arrives. Naming the steps says what is
 * happening, which is what somebody who has just paid is actually asking.
 *
 * ## What it does when it cannot tell
 *
 * Provisioning has no failure signal yet, so this screen must never claim one
 * — and must never trap somebody either. After a while it stops saying "a few
 * seconds", says plainly that this is taking longer than it should, and offers
 * the two ways out that always work: use storage of your own, or ask a person.
 */
export interface ManagedSettlingState {
  /** The plan has turned active — the webhook landed. */
  paid: boolean;
  /** Storage exists and answers. */
  storageReady: boolean;
  /** Long enough that "a few seconds" has stopped being true. */
  slow: boolean;
}

export function ManagedSettling({
  state,
  contextName,
  onUseOwnStorage,
  onCarryOn,
}: {
  state: ManagedSettlingState;
  contextName: string;
  /** The free path out, which is always available and never a punishment. */
  onUseOwnStorage: () => void;
  /** Leave the flow; the work finishes without this tab. */
  onCarryOn: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

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
          ? "Stripe has your payment and we are still setting up. You can close this — " +
            "we will finish on our own, and your context will be ready when you come back."
          : `Setting up storage for ${contextName}. This usually takes a few seconds.`}
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
          {/*
            Two ways out, and neither is a dead end. The first is free and
            immediate; the second is a person. Offered only once the wait has
            stopped being ordinary, because offering them at second three would
            read as expecting this to fail.
          */}
          <Notice tone="warn" style={styles.card} testID="managed-settling-slow">
            <Text variant="rowSub">
              Longer than it should be. Your payment is safe and nothing has been lost. You
              can carry on and we will finish in the background, or connect storage you own
              instead — tell us if you do, and we will stop the subscription.
            </Text>
          </Notice>
          <Row style={styles.actions}>
            <Button label="Carry on" onPress={onCarryOn} testID="managed-settling-carry-on" />
            <Button
              label="Connect storage I own"
              variant="ghost"
              onPress={onUseOwnStorage}
              testID="managed-settling-own"
            />
          </Row>
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
  });
