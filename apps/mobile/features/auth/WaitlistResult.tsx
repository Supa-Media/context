import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { EmailSignIn } from "./useEmailSignIn";

/**
 * What the one email field turns into for somebody not let in yet: "you're on
 * the list", or "you're already on the list". Drawn in place of the field on
 * `/login` and in the homepage's `JoinCard`, never on another page.
 *
 * A new name gets one optional question, "what would you use it for?", which
 * helps staff pick who goes first. Skipping it changes nothing, and it is
 * asked once.
 */
export function WaitlistResult({ flow }: { flow: EmailSignIn }) {
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState("");
  const email = flow.email.trim();
  const joined = flow.step === "joined";

  return (
    <View style={styles.wrap} testID="waitlist-result">
      <View style={styles.mark} aria-hidden>
        <Text style={styles.markText}>✓</Text>
      </View>
      <Text role="heading" aria-level={2} style={styles.title}>
        {joined ? "You're on the list" : "You're already on the list"}
      </Text>
      <Text variant="rowSub" style={styles.body}>
        {joined ? "We'll email " : "Nothing else to do. We'll email "}
        <Text style={styles.strong}>{email}</Text> when it's your turn.
      </Text>
      {joined && !flow.described ? (
        <View style={styles.ask}>
          <TextField
            label="What would you use it for?"
            optional
            value={answer}
            onChangeText={setAnswer}
            maxLength={280}
            placeholder="A few words is plenty"
            onSubmitEditing={() => void flow.sendUseFor(answer)}
            testID="waitlist-use-for"
          />
          <Button
            label="Send"
            variant="decision"
            disabled={answer.trim().length === 0}
            onPress={() => void flow.sendUseFor(answer)}
            style={styles.send}
            testID="waitlist-use-for-send"
          />
        </View>
      ) : null}
      {joined && flow.described ? (
        <Text variant="foot" role="status" style={styles.thanks}>
          Thanks, that helps.
        </Text>
      ) : null}
      <Text variant="foot" role="link" style={styles.link} onPress={flow.changeEmail} testID="waitlist-change-email">
        Use a different email
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x2 },
    mark: {
      width: 28,
      height: 28,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      alignItems: "center",
      justifyContent: "center",
    },
    markText: { color: colors.warn, fontWeight: "700" },
    title: { fontFamily: fonts.display, fontSize: t.h3, fontWeight: "600", color: colors.text },
    body: { color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    ask: { marginTop: space.x3, gap: space.x2 },
    send: { alignSelf: "flex-start" },
    thanks: { color: colors.muted },
    link: { marginTop: space.x2, color: colors.accent, fontWeight: "600" },
  });
