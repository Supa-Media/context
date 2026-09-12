import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row } from "../../design/components/Card";
import { Hint } from "../../design/components/Field";
import { FormError, Notice, ToggleGroup } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  EXPORT_PROMISE,
  entitlementRows,
  entitlementsHint,
  formatBytes,
  formatPrice,
  type PremiumEntitlements,
  type PremiumStatus,
} from "../../console/settings/panels/premium";

/**
 * The last screen before Stripe, in a first run.
 *
 * ## Why there is a screen here at all
 *
 * Because everything a person has to know before an irreversible, outward
 * step has to be on one screen, and none of it fits on a card in a list: what
 * it costs, that it covers **this brain and nothing else**, that a second
 * thing is included at the same price, where they are about to go, and what
 * they will come back to. A choice card that went straight to Stripe would be
 * asking somebody to pay before they had been told the price in full.
 *
 * ## What it does not do
 *
 * It does not sell. There is no comparison table, no "most popular", no
 * urgency and no discount — there is no discount to offer, and inventing a
 * reason to hurry somebody into a subscription is the dark pattern this
 * product's own pricing note forbids by name.
 *
 * ## The copy is not this file's to vary
 *
 * The price, the ceiling, the two entitlement rows and the export promise all
 * come from `features/console/settings/panels/premium.ts` — the same module
 * the settings section reads. A second copy of the sentence that says leaving
 * is free is the one change here that would look like a tidy-up and be a
 * product change (`CLAUDE.md`, non-negotiable #1).
 *
 * Pure, and driven by props: `StorageStep` maps the controller onto it, and
 * the browser suite mounts it directly.
 */
export type ManagedConfirmState = "choosing" | "opening" | "ready" | "failed";

/**
 * What happens after the payment, in a first run.
 *
 * Stripe returns to `/welcome`, so the flow the person is standing in is the
 * flow they come back to, and saying "back here" is true. It is **not** true
 * everywhere this screen is used — see `afterPay` below — which is why the
 * sequence is a default rather than a literal in the JSX.
 */
export const FIRST_RUN_AFTER_PAY = [
  "Stripe brings you back here.",
  "We create your storage and lay out the standard folders.",
  "Your context is ready — usually in a few seconds.",
] as const;

export function ManagedConfirm({
  status,
  contextName,
  state,
  failure,
  afterPay = FIRST_RUN_AFTER_PAY,
  onToggle,
  onContinue,
  onBack,
}: {
  /** The plan as the control plane reports it, for price, ceiling and choice. */
  status: PremiumStatus;
  /** What is being upgraded, in the words the person just chose: `@seyi`. */
  contextName: string;
  state: ManagedConfirmState;
  /** Our sentence for a failed attempt, never Stripe's and never a stack. */
  failure?: string;
  /**
   * Where the payment leads, in order — the one thing on this screen that is
   * genuinely a function of the flow it is drawn in.
   *
   * A first run comes back to itself; creating a workspace does not, because
   * that flow lives in component state and Stripe returns to a URL. Saying
   * "back here" there would be a promise the redirect cannot keep, which is
   * the class of copy this screen exists to get right.
   */
  afterPay?: readonly string[];
  onToggle: (value: string, next: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const price = formatPrice(status);
  const chosen = status.selected.managedStorage || status.selected.fastSearch;

  return (
    <View>
      <Text variant="rowTitle">Context keeps your notes</Text>
      <Text variant="rowSub" style={styles.lede}>
        You are subscribing to the services we run for this context. You are not buying
        your files — those are yours either way, and always leave with you.
      </Text>

      {/*
        The billable unit, said before the price rather than after it. It is the
        thing people get wrong: they assume an account is being upgraded, and
        they find out otherwise on the second context.
      */}
      <Notice style={styles.gap} testID="managed-confirm-unit">
        <Text variant="rowSub">
          This applies to {contextName} and nothing else. Every other brain or workspace
          you can reach stays exactly as it is.
        </Text>
      </Notice>

      <Card style={styles.gap}>
        <ToggleGroup
          label="What Premium includes"
          hint={entitlementsHint(status)}
          options={entitlementRows(status)}
          onToggle={onToggle}
          disabled={state === "opening" || state === "ready"}
          testID="managed-confirm-entitlement"
        />
        <Row divided style={styles.priceRow}>
          <Text variant="rowSub">Price</Text>
          <Text variant="rowTitle" testID="managed-confirm-price">
            {price}
          </Text>
        </Row>
        <Hint style={styles.gap}>
          <Text variant="rowSub">
            Billed monthly. Cancel any time from this context&apos;s settings; cancelling
            never deletes a note. Up to {formatBytes(status.ceilingBytes)} of notes and
            attachments — stored bytes are not metered yet, and we will tell you long
            before it matters.
          </Text>
        </Hint>
      </Card>

      <View style={styles.gap}>
        <Text variant="eyebrow">What happens after you pay</Text>
        <View style={styles.steps}>
          {afterPay.map((line, index) => (
            <View key={line} style={styles.stepRow}>
              {/*
                Numbered, because this genuinely is a sequence — three things
                that happen in an order the person is about to live through.
              */}
              <Text variant="rowSub" style={styles.stepNumber}>
                {index + 1}
              </Text>
              <Text variant="rowSub" style={styles.stepBody}>
                {line}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {failure === undefined ? null : (
        <FormError headline={failure} style={styles.gap} />
      )}

      {chosen ? null : (
        <Hint style={styles.gap}>
          <Text variant="rowSub">
            Tick managed storage, fast search, or both to continue.
          </Text>
        </Hint>
      )}

      <Row style={styles.actions}>
        {/*
          Two presses, and the second one is the one that leaves: minting the
          page needs the payment key, which only a scheduled action may open,
          so the URL arrives a beat after the first press. A navigation that
          happens on its own seconds after somebody pressed something else is
          the kind a browser blocks and a person does not trust.
        */}
        <Button
          label={
            state === "opening"
              ? "Opening…"
              : state === "ready"
                ? "Continue to Stripe"
                : "Continue"
          }
          accessibilityLabel={
            state === "ready"
              ? "Open the payment page, which is hosted by Stripe"
              : "Continue to payment"
          }
          variant="decision"
          disabled={!chosen || state === "opening"}
          trailing={state === "ready" ? <Text variant="rowSub">↗</Text> : undefined}
          onPress={onContinue}
          testID="managed-confirm-continue"
        />
        <Button
          label="Not now"
          variant="ghost"
          disabled={state === "opening"}
          onPress={onBack}
          testID="managed-confirm-back"
        />
        {state === "opening" ? <ActivityIndicator size="small" /> : null}
      </Row>
      <Text variant="foot" style={styles.foot}>
        Payment is handled by Stripe. We never see your card.
      </Text>

      {/*
        THE EXIT, HERE TOO, AND NOT AS A FOOTNOTE.

        The one screen in a first run where somebody is deciding to hand us
        their files is the screen that most owes them the sentence saying they
        can take them back. Constant, unconditional, and the same words the
        settings section uses.
      */}
      <Notice style={styles.gap} testID="managed-confirm-export-promise">
        <Text variant="rowSub">{EXPORT_PROMISE}</Text>
      </Notice>
    </View>
  );
}

/** The entitlements a first run starts from: what they just pressed. */
export const MANAGED_FIRST_CHOICE: PremiumEntitlements = {
  managedStorage: true,
  fastSearch: false,
};

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { marginTop: space.x2, lineHeight: leading(12.5, 1.7) },
    gap: { marginTop: space.x4 },
    priceRow: { marginTop: space.x3, justifyContent: "space-between", alignItems: "center" },
    steps: { marginTop: space.x3, gap: space.x2 },
    stepRow: { flexDirection: "row", gap: space.x3 },
    stepNumber: { color: colors.muted, width: 14 },
    stepBody: { flex: 1, minWidth: 0, lineHeight: leading(13, 1.6) },
    actions: { marginTop: space.x4, gap: space.x3, flexWrap: "wrap", alignItems: "center" },
    foot: { marginTop: space.x3, color: colors.muted },
  });
