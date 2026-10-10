import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { TextField, type TextFieldProps } from "../design/components/Input";
import { TextLink } from "../design/components/TextLink";
import { useThemedStyles } from "../design/theme";

/**
 * A field whose value is a secret: drawn as dots until the person presses
 * Show, the password field's reveal moved out so every value on the page
 * uses the same one. What it holds stays in the caller's state; this keeps
 * only whether it is shown.
 *
 * `revealName` names the thing in the reveal's own label ("Show password",
 * "Show STRIPE_KEY for prod") — a name, never the value.
 */
export function SecretInput({
  revealName,
  testID,
  ...props
}: TextFieldProps & { revealName: string; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [shown, setShown] = useState(false);
  return (
    <View style={styles.wrap}>
      <TextField
        {...props}
        secureTextEntry={!shown}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={[styles.input, props.style]}
        testID={testID}
      />
      {/* Nothing to show in an empty field, so no reveal to press. */}
      {props.value ? (
        <TextLink
          label={shown ? "Hide" : "Show"}
          style={styles.reveal}
          accessibilityLabel={`${shown ? "Hide" : "Show"} ${revealName}`}
          onPress={() => setShown((value) => !value)}
          testID={`${testID}-reveal`}
        />
      ) : null}
    </View>
  );
}

// The reveal sits inside the well, over its right edge; the well's height is
// its 13pt padding twice plus one line, so 48 centres it. A hint or error
// under the field would push the well up, so callers put those elsewhere.
const WELL_HEIGHT = 48;

const makeStyles = () =>
  StyleSheet.create({
    wrap: { position: "relative" },
    input: { paddingRight: 64 },
    reveal: {
      position: "absolute",
      right: 14,
      bottom: 0,
      lineHeight: WELL_HEIGHT,
      paddingVertical: 0,
      textDecorationLine: "none",
    },
  });
