import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Button } from "../../features/design/components/Button";
import { Card, Row } from "../../features/design/components/Card";
import { Dot } from "../../features/design/components/Dot";
import { Hint } from "../../features/design/components/Field";
import { Notice } from "../../features/design/components/Input";
import { Pill } from "../../features/design/components/Pill";
import { Text } from "../../features/design/components/Text";
import { leading, radii, space } from "../../features/design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../features/design/theme";

/**
 * The pieces the proposed frames are drawn from.
 *
 * Every one of them is `features/design` underneath — the same `Card`, `Row`,
 * `Button`, `Pill`, `Notice` and `Text` variants the console already uses, with
 * the same tokens. Two of them (`ChoiceCard`, `StepList`) have no production
 * equivalent yet and are the actual proposals; the rest are arrangements.
 *
 * `ChoiceCard` is deliberately a near-copy of the private one inside
 * `features/console/storage/StorageChoice.tsx` rather than an import of it: the
 * production card is not exported, and exporting it to serve a prototype would
 * be a production change made to make a mock easier — which is how a review
 * artifact starts editing the product it is supposed to be reviewed against.
 * If variant A is approved, the two become one component in `features/` and
 * this copy goes.
 */

/** Where a press in the prototype goes. `null` means "nothing to click here". */
export type Goto = string | null;

/** `testID` a hotspot carries, so the prototype runtime can route the click. */
export function hotspot(to: Goto): string | undefined {
  return to === null ? undefined : `goto-${to}`;
}

/**
 * One square-ish option in a choice row.
 *
 * `flexBasis` plus `flexWrap` on the row is what stacks these on a phone
 * without a width branch — the production card's own reasoning, kept because
 * `useWindowDimensions` is 0 under jsdom and a width branch would silently make
 * every rendered frame take the phone path.
 */
export function ChoiceCard({
  title,
  sub,
  badge,
  badgeTone = "ok",
  selected = false,
  busy = false,
  disabled = false,
  wide = false,
  goto,
  testID,
}: {
  title: string;
  sub: string;
  badge?: string;
  /** `ok` for "recommended", `neutral` for a price — a price is not a boast. */
  badgeTone?: "ok" | "neutral";
  /**
   * A card on its own row rather than one of a pair.
   *
   * It drops the square minimum, which exists so two cards side by side agree
   * on a height. Kept on a full-width card it is 132pt of empty box under three
   * lines of copy — which reads as an unfinished card rather than a spacious
   * one, and was the first thing wrong with the rendered frame.
   */
  wide?: boolean;
  selected?: boolean;
  busy?: boolean;
  disabled?: boolean;
  goto: Goto;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID ?? hotspot(goto)}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled, busy }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.choice,
        wide && styles.choiceWide,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
        disabled && styles.choiceDisabled,
      ]}
    >
      {badge === undefined ? null : (
        <Text
          variant="foot"
          style={badgeTone === "ok" ? styles.badgeOk : styles.badgeNeutral}
        >
          {badge}
        </Text>
      )}
      <Text variant="rowTitle">{title}</Text>
      <Text variant="rowSub" style={styles.choiceSub}>
        {sub}
      </Text>
      {busy ? <ActivityIndicator size="small" color={colors.text2} style={styles.busy} /> : null}
    </Pressable>
  );
}

/** The row `ChoiceCard`s sit in: one line on a pointer, stacked on a phone. */
export function ChoiceRow({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.choices}>{children}</View>;
}

export interface StepState {
  label: string;
  state: "done" | "working" | "waiting" | "failed";
}

/**
 * The provisioning progress list.
 *
 * A named list rather than a bar, for `StepRail`'s reason one screen up: a bar
 * implies a percentage, and this one cannot honestly produce one — the wait is
 * a webhook that arrives when it arrives. Naming the steps says what is
 * happening, which is what somebody who has just been charged $20 is actually
 * asking.
 */
export function StepList({ steps, testID }: { steps: ReadonlyArray<StepState>; testID?: string }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.steps} testID={testID}>
      {steps.map((step) => (
        <View key={step.label} style={styles.stepRow}>
          {step.state === "working" ? (
            <ActivityIndicator size="small" color={colors.text2} style={styles.stepMark} />
          ) : (
            <View style={styles.stepMark}>
              <Dot
                tone={
                  step.state === "done" ? "ok" : step.state === "failed" ? "crit" : "neutral"
                }
              />
            </View>
          )}
          <Text
            variant="rowSub"
            style={[
              styles.stepLabel,
              step.state === "waiting" && styles.stepWaiting,
              step.state === "done" && styles.stepDone,
            ]}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A short list of plain statements — "what stays the same", "what happens next". */
export function PointList({ points }: { points: ReadonlyArray<string> }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.points}>
      {points.map((point) => (
        <View key={point} style={styles.pointRow}>
          <Text variant="rowSub" style={styles.pointMark} aria-hidden>
            ·
          </Text>
          <Text variant="rowSub" style={styles.pointBody}>
            {point}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The price, said once, in the shape the settings card already says it. */
export function PriceRow({ price, note }: { price: string; note?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Row divided style={styles.priceRow}>
        <Text variant="rowSub">Price</Text>
        <Text variant="rowTitle" testID="proto-price">
          {price}
        </Text>
      </Row>
      {note === undefined ? null : (
        <Hint style={styles.gapTop}>
          <Text variant="rowSub">{note}</Text>
        </Hint>
      )}
    </View>
  );
}

/**
 * The banner a read-only context carries.
 *
 * Drawn at the head of the context rather than inside settings, because a
 * person who cannot save a note looks at the note, not at a billing screen.
 */
export function StateBanner({
  tone,
  title,
  body,
  primary,
  secondary,
  testID,
}: {
  tone: "warn" | "neutral";
  title: string;
  body: string;
  primary?: { label: string; goto: Goto };
  secondary?: { label: string; goto: Goto };
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Notice tone={tone} style={styles.banner} testID={testID}>
      <View style={styles.bannerHead}>
        <Pill tone={tone === "warn" ? "warn" : "neutral"} leading={<Dot tone={tone} />}>
          Read-only
        </Pill>
        <Text variant="rowTitle" style={styles.bannerTitle}>
          {title}
        </Text>
      </View>
      <Text variant="rowSub" style={styles.bannerBody}>
        {body}
      </Text>
      {primary === undefined && secondary === undefined ? null : (
        <Row style={styles.bannerActions}>
          {primary === undefined ? null : (
            <Button
              label={primary.label}
              variant="decision"
              testID={hotspot(primary.goto)}
            />
          )}
          {secondary === undefined ? null : (
            <Button label={secondary.label} variant="ghost" testID={hotspot(secondary.goto)} />
          )}
        </Row>
      )}
    </Notice>
  );
}

/** A titled block inside a panel — the shape the settings panels already use. */
export function Block({
  title,
  sub,
  children,
  style,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  style?: ViewStyle;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={StyleSheet.flatten([styles.block, style])}>
      <Text variant="rowTitle">{title}</Text>
      {sub === undefined ? null : (
        <Text variant="rowSub" style={styles.blockSub}>
          {sub}
        </Text>
      )}
      <View style={styles.blockBody}>{children}</View>
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    choices: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    choice: {
      flexGrow: 1,
      flexBasis: 220,
      minHeight: 132,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: space.x4,
      paddingHorizontal: space.x4,
    },
    choiceWide: { flexBasis: "100%", minHeight: 0 },
    choiceSelected: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },
    choicePressed: { backgroundColor: colors.surface3 },
    choiceDisabled: { opacity: 0.55 },
    choiceSub: { lineHeight: leading(13, 1.55) },
    badgeOk: { color: colors.okText },
    badgeNeutral: { color: colors.text2 },
    busy: { position: "absolute", top: 14, right: 14 },

    steps: { gap: space.x3, marginTop: space.x4 },
    stepRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    stepMark: { width: 16, alignItems: "center" },
    stepLabel: { flex: 1, minWidth: 0 },
    stepWaiting: { color: colors.muted },
    stepDone: { color: colors.text },

    points: { gap: space.x2, marginTop: space.x3 },
    pointRow: { flexDirection: "row", gap: space.x2 },
    pointMark: { color: colors.muted, width: 10 },
    pointBody: { flex: 1, minWidth: 0, lineHeight: leading(13, 1.6) },

    priceRow: { marginTop: space.x3, justifyContent: "space-between", alignItems: "center" },
    gapTop: { marginTop: space.x3 },

    banner: { marginTop: space.x3 },
    bannerHead: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    bannerTitle: { flexShrink: 1 },
    bannerBody: { marginTop: space.x2, lineHeight: leading(13, 1.6) },
    bannerActions: { marginTop: space.x3, gap: space.x2, flexWrap: "wrap" },

    block: { marginTop: space.x3 },
    blockSub: { marginTop: space.x1, lineHeight: leading(13, 1.6) },
    blockBody: { marginTop: space.x3 },
  });
