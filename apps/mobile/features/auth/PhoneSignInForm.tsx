import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { ALREADY_HEADING, JOINED_HEADING, PHONE_SIGN_IN_HEADING, WAITLIST_WHY } from "./phoneSignIn";
import type { PhoneSignIn } from "./usePhoneSignIn";

/**
 * The phone half of the sign-in page (board p1): a number, then the texted
 * code. A number not let in yet goes on the waitlist, said here in place
 * ("login and waitlist sign up" by phone, Dev2 2026-10-09). Email stays one
 * small link away. `usePhoneSignIn` is the state; the
 * page around it (`LoginScreen`) draws the wordmark and the picture.
 */
export function PhoneSignInForm({ flow, onUseEmail }: { flow: PhoneSignIn; onUseEmail: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { sentTo, submitting, error } = flow;
  const spinner = submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  if (flow.waitlist !== null) {
    return (
      <View testID="login-phone-waitlist">
        <Text role="heading" aria-level={1} style={styles.pitch}>
          {flow.waitlist === "joined" ? JOINED_HEADING : ALREADY_HEADING}
        </Text>
        <Text variant="rowSub" style={styles.sent}>
          {WAITLIST_WHY}
        </Text>
        <Text variant="foot" style={styles.foot}>
          <Text variant="foot" role="link" style={styles.link} onPress={flow.changeNumber} testID="login-phone-change">
            Use a different number
          </Text>
          {" · Invited by email? "}
          <Text variant="foot" role="link" style={styles.link} onPress={onUseEmail} testID="login-use-email">
            Use email instead
          </Text>
        </Text>
      </View>
    );
  }

  if (sentTo === null) {
    return (
      <View>
        <Text variant="eyebrow" style={styles.eyebrow}>
          Invite only for now
        </Text>
        <Text role="heading" aria-level={1} style={styles.pitch}>
          {PHONE_SIGN_IN_HEADING}
        </Text>
        <View style={styles.field}>
          <TextField
            label="Phone number"
            value={flow.phone}
            onChangeText={flow.setPhone}
            placeholder="+1 555 555 0100"
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            editable={!submitting}
            onSubmitEditing={() => {
              if (flow.canSend && !submitting) void flow.send();
            }}
            testID="login-phone"
          />
        </View>
        {error ? (
          <Text variant="error" role="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <View style={styles.primaryRow}>
          <Button
            label="Text me a code"
            variant="accent"
            disabled={submitting || !flow.canSend}
            onPress={() => void flow.send()}
            trailing={spinner}
            style={styles.stretch}
            testID="login-phone-send"
          />
        </View>
        <Text variant="foot" style={styles.foot}>
          No phone?{" "}
          <Text variant="foot" role="link" style={styles.link} onPress={onUseEmail} testID="login-use-email">
            Use email instead
          </Text>
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text role="heading" aria-level={1} style={styles.pitch}>
        Check your texts.
      </Text>
      <Text variant="rowSub" style={styles.sent}>
        We texted a code to <Text style={styles.strong}>{sentTo}</Text>.
      </Text>
      <Text variant="eyebrow" style={styles.label}>
        Code
      </Text>
      <CodeBoxes
        value={flow.code}
        editable={!submitting}
        onChange={(value) => {
          flow.setCode(value);
          if (value.length === OTP_LENGTH && !submitting) void flow.verify(value);
        }}
        testID="login-phone-code"
      />
      {flow.resent ? (
        <Text variant="foot" role="status" style={styles.resent}>
          A new code is on its way. The last one no longer works.
        </Text>
      ) : null}
      {error ? (
        <Text variant="error" role="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.primaryRow}>
        <Button
          label="Continue →"
          variant="accent"
          disabled={submitting || flow.code.length !== OTP_LENGTH}
          onPress={() => void flow.verify()}
          trailing={spinner}
          style={styles.stretch}
          testID="login-phone-verify"
        />
      </View>
      <Text variant="foot" style={styles.foot}>
        <Text variant="foot" role="link" style={styles.link} onPress={() => void flow.send(true)} testID="login-phone-resend">
          Text a new code
        </Text>
        {" · "}
        <Text variant="foot" role="link" style={styles.link} onPress={flow.changeNumber} testID="login-phone-change">
          Use a different number
        </Text>
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    eyebrow: { marginBottom: space.x2, color: colors.muted },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    field: { marginTop: space.x6 },
    sent: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    label: { marginTop: space.x5, marginBottom: space.x2, color: colors.muted },
    resent: { marginTop: space.x3, color: colors.muted },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x5, alignSelf: "stretch" },
    stretch: { alignSelf: "stretch", justifyContent: "center" },
    foot: { marginTop: space.x4, color: colors.muted, lineHeight: leading(12.5, 1.5) },
    link: { color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
  });
