import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { TOPIC_LABELS, changesCopy, sourceLine, stepLabel, stepLines } from "./changeCopy";
import type { ChangeCard as Card, ChangeStep, OrganizerDecision } from "./types";

/**
 * What changed: one card per thing an arrival says changed — the "Waiting for
 * you" cards of the What changed board.
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
}: {
  cards: readonly Card[];
  busy: ReadonlySet<string>;
  touch: boolean;
  onResolve: (card: Card, decision: OrganizerDecision, steps: readonly string[]) => void;
}) {
  const styles = useThemedStyles(makeChangeStyles);
  if (cards.length === 0) return null;
  return (
    <View testID="organizer-changes">
      <View style={styles.divider}>
        <Text variant="eyebrow" style={styles.muted}>
          {changesCopy.heading}
        </Text>
        <View style={styles.rule} />
      </View>
      <Text variant={touch ? "rowSub" : "treeMeta"} style={[styles.muted, styles.note, touch && styles.noteTouch]}>
        {changesCopy.note}
      </Text>
      {cards.map((card) => (
        <ChangeCardRow key={card.id} card={card} pending={busy.has(card.id)} touch={touch} onResolve={onResolve} />
      ))}
    </View>
  );
}

function ChangeCardRow({
  card,
  pending,
  touch,
  onResolve,
}: {
  card: Card;
  pending: boolean;
  touch: boolean;
  onResolve: (card: Card, decision: OrganizerDecision, steps: readonly string[]) => void;
}) {
  const styles = useThemedStyles(makeChangeStyles);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const ticked = card.steps.filter((step) => !off.has(step.id)).map((step) => step.id);
  const toggle = (id: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <View style={[styles.card, touch && styles.cardTouch]} testID={`organizer-change-${card.id}`}>
      <Text variant="eyebrow" style={styles.topic}>
        {TOPIC_LABELS[card.topic]}
      </Text>
      <Text variant={touch ? "rowTitle" : "tree"} style={styles.headline}>
        {card.headline}
      </Text>
      <Text variant={touch ? "rowSub" : "treeMeta"} style={styles.quote}>
        {`“${card.quote}”`}
      </Text>
      <Text variant={touch ? "rowSub" : "treeMeta"} style={styles.muted}>
        {sourceLine(card.source)}
      </Text>
      <View style={styles.steps}>
        {card.steps.map((step) => (
          <StepRow key={step.id} step={step} on={!off.has(step.id)} touch={touch} disabled={pending} onToggle={() => toggle(step.id)} />
        ))}
      </View>
      <View style={styles.acts}>
        <Button
          label={changesCopy.apply(ticked.length)}
          onPress={() => onResolve(card, "accept", ticked)}
          disabled={pending || ticked.length === 0}
          variant="dialogPrimary"
          style={touch ? undefined : styles.actSmall}
          testID={`organizer-change-apply-${card.id}`}
        />
        <Button
          label={changesCopy.wrong}
          accessibilityLabel={`${changesCopy.wrong}: ${card.headline}`}
          onPress={() => onResolve(card, "dismiss", [])}
          disabled={pending}
          variant={touch ? "dialog" : "mini"}
          testID={`organizer-change-wrong-${card.id}`}
        />
      </View>
    </View>
  );
}

function StepRow({
  step,
  on,
  touch,
  disabled,
  onToggle,
}: {
  step: ChangeStep;
  on: boolean;
  touch: boolean;
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
      style={[styles.step, touch && styles.stepTouch]}
      testID={`organizer-change-step-${step.id}`}
    >
      <View style={[styles.tick, on && styles.tickOn]} aria-hidden>
        {on ? <Icon name="check" size={11} color={colors.ground} /> : null}
      </View>
      <View style={styles.stepText}>
        <Text variant={touch ? "rowSub" : "tree"} style={on ? styles.stepLine : styles.stepLineOff}>
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
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3 + space.x1,
      paddingTop: space.x3,
      paddingBottom: space.x1,
    },
    rule: { flexGrow: 1, height: 1, backgroundColor: colors.line },
    muted: { color: colors.chromeMuted },
    note: { paddingHorizontal: space.x3 + space.x1 },
    noteTouch: { paddingHorizontal: space.x1 },
    card: {
      gap: 4,
      paddingVertical: space.x3,
      paddingHorizontal: space.x3 + space.x1,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    cardTouch: { paddingHorizontal: space.x1 },
    topic: { color: colors.accent },
    headline: { color: colors.text, fontWeight: "600" },
    quote: { color: colors.text2, fontStyle: "italic" },
    steps: { marginTop: space.x2, marginBottom: space.x1, gap: 2 },
    step: { flexDirection: "row", alignItems: "flex-start", gap: space.x2, paddingVertical: 4, borderRadius: radii.sm },
    stepTouch: { paddingVertical: space.x2 },
    // `ToggleGroup`'s box (design/components/Input.tsx), with a tick a person reads as "will happen".
    tick: {
      width: 16,
      height: 16,
      marginTop: 2,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    tickOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    stepText: { flex: 1, minWidth: 0 },
    stepLine: { color: colors.text },
    stepLineOff: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    acts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2, marginTop: space.x2 },
    actSmall: { paddingVertical: 6, paddingHorizontal: 12 },
  });
