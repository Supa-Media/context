import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { TOPIC_LABELS, changesCopy, sourceLine, stepLabel, stepLines } from "./changeCopy";
import type { ChangeCard as Card, ChangeStep, OrganizerDecision } from "./types";

/**
 * What changed: one card per thing an arrival says changed — the "Waiting for
 * you" cards of the What changed board, drawn on its page.
 *
 * Every card says what it read, quotes the sentence that says so, and lists
 * its steps ticked. Unticking leaves a step as it is; Apply does the rest, and
 * "This is wrong" puts the card away for good. Nothing happens without a press.
 */
export function ChangeCards({
  cards,
  busy,
  touch,
  onResolve,
  onOpenSource,
}: {
  cards: readonly Card[];
  busy: ReadonlySet<string>;
  touch: boolean;
  onResolve: (card: Card, decision: OrganizerDecision, steps: readonly string[]) => void;
  /** Open the meeting, email or chat a card was read from. */
  onOpenSource?: (path: string) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <View testID="organizer-changes">
      {cards.map((card) => (
        <ChangeCardRow
          key={card.id}
          card={card}
          pending={busy.has(card.id)}
          touch={touch}
          onResolve={onResolve}
          onOpenSource={onOpenSource}
        />
      ))}
    </View>
  );
}

function ChangeCardRow({
  card,
  pending,
  touch,
  onResolve,
  onOpenSource,
}: {
  card: Card;
  pending: boolean;
  touch: boolean;
  onResolve: (card: Card, decision: OrganizerDecision, steps: readonly string[]) => void;
  onOpenSource?: (path: string) => void;
}) {
  const styles = useThemedStyles(makeChangeStyles);
  const colors = useColors();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const ticked = card.steps.filter((step) => !off.has(step.id)).map((step) => step.id);
  const toggle = (id: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const source = sourceLine(card.source);

  return (
    <View
      style={[styles.card, touch && styles.cardTouch]}
      role="group"
      aria-label={card.headline}
      testID={`organizer-change-${card.id}`}
    >
      <View style={[styles.head, touch && styles.headTouch]}>
        <View style={styles.headText}>
          <Text variant="eyebrow" style={styles.topic}>
            {TOPIC_LABELS[card.topic]}
          </Text>
          <Text variant="noteTitle" role="heading" aria-level={2} style={styles.headline}>
            {card.headline}
          </Text>
        </View>
        <View style={styles.acts}>
          <Button
            label={changesCopy.wrong}
            accessibilityLabel={`${changesCopy.wrong}: ${card.headline}`}
            onPress={() => onResolve(card, "dismiss", [])}
            disabled={pending}
            variant="dialog"
            testID={`organizer-change-wrong-${card.id}`}
          />
          <Button
            label={changesCopy.apply(ticked.length)}
            onPress={() => onResolve(card, "accept", ticked)}
            disabled={pending || ticked.length === 0}
            variant="dialogPrimary"
            testID={`organizer-change-apply-${card.id}`}
          />
        </View>
      </View>
      {onOpenSource ? (
        <PressRow
          role="link"
          accessibilityLabel={`${source}. Open it`}
          onPress={() => onOpenSource(card.source.path)}
          radius={radii.pill}
          style={styles.chip}
          hoverStyle={styles.chipHover}
          testID={`organizer-change-source-${card.id}`}
        >
          <Icon name="file" size={12} color={colors.text2} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.chipText}>
            {source}
          </Text>
        </PressRow>
      ) : (
        <Text variant="treeMeta" style={styles.muted}>
          {source}
        </Text>
      )}
      <Text variant={touch ? "rowSub" : "body"} style={styles.quote}>
        {`“${card.quote}”`}
      </Text>
      <View style={styles.steps}>
        {card.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            on={!off.has(step.id)}
            touch={touch}
            last={index === card.steps.length - 1}
            disabled={pending}
            onToggle={() => toggle(step.id)}
          />
        ))}
      </View>
    </View>
  );
}

function StepRow({
  step,
  on,
  touch,
  last,
  disabled,
  onToggle,
}: {
  step: ChangeStep;
  on: boolean;
  touch: boolean;
  last: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const styles = useThemedStyles(makeChangeStyles);
  const colors = useColors();
  const { line, sub } = stepLines(step);
  return (
    <Pressable
      role="checkbox"
      aria-checked={on}
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={stepLabel(step)}
      disabled={disabled}
      onPress={onToggle}
      style={[styles.step, touch && styles.stepTouch, last && styles.stepLast]}
      testID={`organizer-change-step-${step.id}`}
    >
      <View style={[styles.tick, on && styles.tickOn]} aria-hidden>
        {on ? <Icon name="check" size={11} color={colors.ground} /> : null}
      </View>
      {/* The step and what it replaces side by side, as the board drew them; stacked on a phone. */}
      <View style={[styles.stepText, !touch && styles.stepTextWide]}>
        <Text variant={touch ? "rowSub" : "body"} style={[styles.stepLine, !on && styles.stepLineOff]}>
          {line}
        </Text>
        {sub ? (
          <Text variant="treeMeta" style={styles.muted}>
            {sub}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeChangeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      gap: space.x3,
      padding: space.x6,
      marginBottom: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    cardTouch: { padding: space.x4 },
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x4, flexWrap: "wrap" },
    headTouch: { flexDirection: "column", alignItems: "stretch" },
    headText: { flex: 1, minWidth: 200, gap: space.x1 },
    topic: { color: colors.accent },
    headline: { color: colors.text },
    acts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    chip: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: radii.pill,
      backgroundColor: colors.chipFill,
    },
    chipHover: { backgroundColor: colors.surface3 },
    chipText: { color: colors.text2, flexShrink: 1 },
    muted: { color: colors.chromeMuted },
    quote: { color: colors.text2, fontStyle: "italic" },
    steps: { borderTopWidth: 1, borderTopColor: colors.line },
    step: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x3,
      paddingVertical: space.x3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    stepTouch: { paddingVertical: space.x3 },
    stepLast: { borderBottomWidth: 0, paddingBottom: 0 },
    // `ToggleGroup`'s box (design/components/Input.tsx), with a tick a person reads as "will happen".
    tick: {
      width: 18,
      height: 18,
      marginTop: 2,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    tickOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    stepText: { flex: 1, minWidth: 0, gap: 2 },
    stepTextWide: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.x4, flexWrap: "wrap" },
    stepLine: { color: colors.text, flexShrink: 1 },
    stepLineOff: { color: colors.chromeMuted, textDecorationLine: "line-through" },
  });
