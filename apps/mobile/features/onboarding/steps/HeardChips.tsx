import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Text } from "../../design/components/Text";
import { pointerType as t, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { firstTouch } from "../../auth/firstTouch";
import { useSignupChannel } from "../../auth/useSignupChannel";

/**
 * "How did you hear about us?" under Claim on the handle screen (Dev2,
 * 2026-11-28, boards `signup-channel-chip/c1.png` and `c2.png`). Optional: one
 * tap records the answer as the account's sign-up channel
 * (`signupChannels.heard`), skipping it changes nothing.
 *
 * Shown only when nothing said where the person came from: this browser saw no
 * referrer, utm or ref, and the server has no channel but `direct` for the
 * account (`signupChannels.heardAsk`).
 */
export const HEARD_CHOICES = [
  { answer: "search", label: "Search" },
  { answer: "ai", label: "ChatGPT or another AI" },
  { answer: "x", label: "X" },
  { answer: "friend", label: "A friend or invite" },
  { answer: "other", label: "Other" },
] as const;

export type Answer = (typeof HEARD_CHOICES)[number]["answer"];

/** Whether this browser's first touch said anything about where it came from. */
export function touchSaidWhere(): boolean {
  const touch = firstTouch();
  return touch !== undefined && (touch.referrer !== undefined || touch.source !== undefined || touch.medium !== undefined || touch.ref !== undefined);
}

export function HeardChips() {
  // The first run comes before the signed-in layout, so the touch is sent from here too (once per device).
  useSignupChannel();
  const ask = useQuery(api.functions.signupChannels.heardAsk, {});
  const answer = useMutation(api.functions.signupChannels.heard);
  if (touchSaidWhere() || ask === undefined || !ask.ask) return null;
  return <HeardChipsView answered={ask.answered ?? null} onAnswer={(choice) => answer({ answer: choice })} />;
}

/** The row itself, given the answer already on the account; the fixture draws it with no server behind it. */
export function HeardChipsView({ answered, onAnswer }: { answered: Answer | null; onAnswer: (answer: Answer) => Promise<unknown> }) {
  const styles = useThemedStyles(makeStyles);
  const [picked, setPicked] = useState<Answer | null>(null);
  const chosen = picked ?? answered;

  return (
    <View style={styles.wrap} testID="welcome-heard">
      <Text variant="rowSub" style={styles.question} nativeID="welcome-heard-question">
        How did you hear about us? <Text variant="rowSub" style={styles.optional}>Optional</Text>
      </Text>
      <View style={styles.chips} role="radiogroup" aria-labelledby="welcome-heard-question">
        {HEARD_CHOICES.map((choice) => {
          const on = chosen === choice.answer;
          return (
            <Pressable
              key={choice.answer}
              role="radio"
              aria-checked={on}
              disabled={chosen !== null}
              onPress={() => {
                setPicked(choice.answer);
                void onAnswer(choice.answer).catch(() => setPicked(null));
              }}
              style={[styles.chip, on ? styles.chipOn : null]}
              testID={`welcome-heard-${choice.answer}`}
            >
              <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{choice.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.line },
    question: { color: colors.text2 },
    optional: { color: colors.muted },
    chips: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
      borderRadius: radii.pill,
      paddingHorizontal: 13,
      paddingVertical: 7,
    },
    chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    chipText: { fontSize: t.ui, color: colors.text2 },
    chipTextOn: { color: colors.accentText, fontWeight: "600" },
  });
