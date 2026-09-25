import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, pointerType as t, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/** The email code's length, as `@supa-media/convex` issues it. */
export const OTP_LENGTH = 6;

/** Digits only, never longer than a code. A pasted "392 418" still works. */
export function codeDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

/**
 * A-02's six boxes, as ONE real text field.
 *
 * Six separate inputs is the usual way to draw this and the wrong way to build
 * it: paste lands in one box, the phone's "from Messages" code suggestion fills
 * one box, and a screen reader announces six unlabelled fields. So there is a
 * single `TextInput` — the one the keyboard, autofill and assistive tech talk
 * to — laid transparently over six boxes that only draw what it holds.
 */
export function CodeBoxes({
  value,
  onChange,
  editable = true,
  testID,
}: {
  value: string;
  onChange: (value: string) => void;
  editable?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const digits = value.split("");
  const active = Math.min(digits.length, OTP_LENGTH - 1);

  return (
    <View style={styles.row}>
      {Array.from({ length: OTP_LENGTH }, (_, index) => (
        <View
          key={index}
          aria-hidden
          style={[
            styles.box,
            index < digits.length && styles.filled,
            focused && index === active && styles.current,
          ]}
        >
          <Text style={styles.digit}>{digits[index] ?? ""}</Text>
        </View>
      ))}
      <TextInput
        value={value}
        onChangeText={(raw) => onChange(codeDigits(raw))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={editable}
        maxLength={OTP_LENGTH}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoFocus
        caretHidden
        accessibilityLabel="Six-digit code"
        style={styles.input}
        testID={testID}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: space.x2, position: "relative", alignSelf: "flex-start" },
    box: {
      width: 44,
      height: 52,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      alignItems: "center",
      justifyContent: "center",
    },
    filled: { borderColor: colors.accent },
    current: { borderColor: colors.accent, borderWidth: 2 },
    digit: { fontFamily: fonts.mono, fontSize: t.h3, color: colors.text },
    // Covers the boxes exactly and draws nothing: taps anywhere on the row
    // focus the one field, and its own glyphs never show over the boxes.
    input: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      color: "transparent",
      backgroundColor: "transparent",
      fontSize: t.label,
      opacity: 0.011,
    },
  });
