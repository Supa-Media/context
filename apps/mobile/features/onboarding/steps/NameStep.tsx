import { useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { fonts, leading, pointerType as t, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  isPreviewable,
  nameConsequences,
  nameFeedback,
  rejectionFeedback,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
} from "../name";
import type { OnboardingController } from "../useOnboarding";

/**
 * A-03 — claim your handle.
 *
 * The field and what the name becomes, and nothing else. **The name is the
 * workspace**, not a label on it, and the live preview says so better than
 * the paragraph that used to sit above the field did — the owner cut that
 * paragraph as too wordy (2026-09-27). The preview updates as they type.
 *
 * The capture address is labelled reserved rather than working (see
 * `captureHonesty.test.ts`). The one sentence kept is that it is permanent.
 * There is no release, rename, or reclaim path in the control plane (issue
 * #10), and finding that out later, from a support reply, is the outcome it
 * exists to prevent.
 *
 * ## Two rules about what is shown back
 *
 * **A refused claim is a state of the field, not a panel below it.** The server
 * re-checks the name inside `createWorkspace`'s transaction and can refuse for
 * any of the reasons the live check can — reserved, malformed, genuinely taken.
 * So the failure goes back under the field with that reason's own sentence, and
 * the `FormError` panel is kept for the failures that are not about the name.
 *
 * **The consequences panel only renders a name that could be theirs.** It shows
 * a live note path and a live capture address, and rendering those for a name
 * the field is currently rejecting put `seyi olujide@context.lc` on screen
 * beside an error saying that is not a valid name.
 */
export function NameStep({ controller }: { controller: OnboardingController }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const { name, setName, nameStatus: status, claiming, claimFailure } = controller;
  const rejection = claimFailure?.nameRejection;
  const feedback =
    rejection === undefined
      ? nameFeedback(status)
      : rejectionFeedback(rejection, status.kind === "empty" ? name : status.normalized);
  const shown = nameConsequences(isPreviewable(status) ? status.normalized : "");
  const available = rejection === undefined && status.kind === "available";

  return (
    <View>
      {/*
        A-03's field: the `@` inside the box, and "✓ Available" at its end
        rather than on a line of its own — the answer sits where the question
        was typed. Every other answer (taken, reserved, malformed, a refusal
        from the server) still gets the full sentence under the field, because
        those are the ones that need explaining.
      */}
      <View style={[styles.box, focused && styles.boxFocused, feedback?.tone === "crit" && styles.boxError]}>
        <Text style={styles.at} aria-hidden>
          @
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="yourname"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          maxLength={NAME_MAX_LENGTH}
          editable={!claiming}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={() => {
            if (controller.canClaim) void controller.claim();
          }}
          accessibilityLabel="Your handle"
          aria-describedby="welcome-name-hint"
          aria-invalid={feedback?.tone === "crit"}
          style={styles.input}
          testID="welcome-name"
        />
        {available ? (
          <Text style={styles.available} role="status" testID="welcome-name-available">
            ✓ Available
          </Text>
        ) : null}
      </View>
      <Text variant="foot" style={styles.hint} nativeID="welcome-name-hint">
        {`Lowercase letters, numbers and hyphens. ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`}
      </Text>

      {feedback && !available ? (
        <Text
          variant={feedback.tone === "crit" ? "error" : "rowSub"}
          role={feedback.tone === "crit" ? "alert" : "status"}
          style={styles.feedback}
          testID="welcome-name-feedback"
        >
          {feedback.message}
        </Text>
      ) : null}

      <View style={styles.consequences}>
        <Consequence label="Workspace" value={shown.context} first />
        <Consequence label="A note in it" value={shown.path} />
        <Consequence label="Reserved capture address" value={shown.mailbox} />
      </View>

      <Text variant="foot" style={styles.permanent}>
        You can't change it later.
      </Text>

      {/*
        Only the failures that are not about the name itself. A refused name is
        already back under the field, in the feedback line, where the fix is.
      */}
      {claimFailure !== null && rejection === undefined ? (
        <FormError headline={claimFailure.headline} next={claimFailure.next} style={styles.failure} />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={
            claiming ? "Claiming…" : status.kind === "available" ? `Claim @${status.normalized}` : "Claim your handle"
          }
          variant="accent"
          disabled={!controller.canClaim}
          onPress={() => void controller.claim()}
          trailing={claiming ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="welcome-name-submit"
        />
      </View>
    </View>
  );
}

/** One line of the preview: what it is, then the literal value. */
function Consequence({ label, value, first = false }: { label: string; value: string; first?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.consequence, !first && styles.consequenceRule]}>
      <Text variant="rowSub" style={styles.consequenceLabel}>
        {label}
      </Text>
      <Text style={styles.consequenceValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: {
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      backgroundColor: colors.well,
      paddingHorizontal: 14,
    },
    boxFocused: { borderColor: colors.accent },
    boxError: { borderColor: colors.crit },
    at: { fontFamily: fonts.mono, fontSize: t.lede, color: colors.muted },
    input: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 12,
      fontFamily: fonts.mono,
      fontSize: t.lede,
      color: colors.text,
      outlineStyle: "none",
    } as object,
    available: { fontSize: t.meta, fontWeight: "600", color: colors.okText },
    hint: { marginTop: 6, color: colors.muted },
    feedback: { marginTop: 8 },
    consequences: {
      marginTop: 22,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.well,
      paddingVertical: 16,
      paddingHorizontal: 18,
    },
    consequence: { paddingVertical: 8, gap: 3 },
    consequenceRule: { borderTopWidth: 1, borderTopColor: colors.line },
    consequenceLabel: { color: colors.text2 },
    consequenceValue: { fontFamily: fonts.mono, fontSize: t.ui, color: colors.text },
    permanent: { marginTop: 16, lineHeight: leading(12.5, 1.5), color: colors.text2 },
    failure: { marginTop: 16 },
    actions: { marginTop: 20, alignSelf: "stretch" },
  });
