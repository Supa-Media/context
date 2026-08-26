import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { clamp, colors, fonts, layout, leading, radii, tracking } from "../design/tokens";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { LANDING_ROUTE, safeNextRoute } from "./redirect";

/**
 * Email OTP sign-in, styled to the console's palette.
 *
 * Two steps — request a code, then verify it — against `@convex-dev/auth`'s
 * email provider, which is configured by `createSupaAuth` in
 * `apps/convex/auth.ts`. There is no password anywhere in the product.
 *
 * A `?next=` parameter survives the round trip, narrowed by `safeNextRoute` on
 * the way through. It exists for the consent screen: an AI client sends someone
 * to `/authorize?request_id=…`, and dropping them on the console afterwards
 * would strand the OAuth attempt with nothing to retry.
 */
export function LoginScreen() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ next?: string | string[] }>();
  const next = safeNextRoute(Array.isArray(params.next) ? params.next[0] : params.next);

  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleSize = clamp(30, 3.4, 44, width);

  async function requestCode() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", { email: email.trim() });
      setStep("verify");
    } catch {
      setError("Couldn't send your code. Check the address and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", { email: email.trim(), code: code.trim() });
      router.replace(next);
    } catch {
      setError("That code didn't work. Codes expire — ask for a new one if it's been a while.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = step === "request" ? email.trim().length > 3 : code.trim().length > 0;

  return (
    <View style={styles.ground}>
      <StageBackdrop />
      <View style={styles.wrap}>
        <Pressable
          onPress={() => router.replace(LANDING_ROUTE)}
          accessibilityLabel="Context.lc home"
          role="link"
          style={styles.mark}
        >
          <Text variant="mark">
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
        </Pressable>

        <Text
          role="heading"
          aria-level={1}
          style={[
            styles.title,
            {
              fontSize: titleSize,
              lineHeight: leading(titleSize, 1.02),
              letterSpacing: tracking(titleSize, -0.03),
            },
          ]}
        >
          {step === "request" ? "Sign in or create your context" : "Check your email"}
        </Text>

        <Text variant="heroSub" style={styles.sub}>
          {step === "request"
            ? "One code by email. No password to lose, and nothing to install."
            : `We sent a one-time code to ${email.trim()}.`}
        </Text>

        <View style={styles.card}>
          {step === "request" ? (
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              editable={!submitting}
              onSubmitEditing={() => {
                if (canSubmit && !submitting) void requestCode();
              }}
              testID="login-email"
            />
          ) : (
            <TextField
              label="One-time code"
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              editable={!submitting}
              onSubmitEditing={() => {
                if (canSubmit && !submitting) void verifyCode();
              }}
              testID="login-code"
            />
          )}

          {error ? (
            <Text variant="error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              label={step === "request" ? "Send code" : "Verify"}
              variant="white"
              disabled={submitting || !canSubmit}
              onPress={() => {
                if (step === "request") void requestCode();
                else void verifyCode();
              }}
              trailing={submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null}
              testID="login-submit"
            />
            {step === "verify" ? (
              <Button
                label="Use a different email"
                variant="ghost"
                disabled={submitting}
                onPress={() => {
                  setStep("request");
                  setCode("");
                  setError(null);
                }}
              />
            ) : null}
          </View>
        </View>

        <Text variant="foot" style={styles.foot}>
          Your notes stay in a bucket you own. Signing in only creates an account in the
          control plane — it never moves a file.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: colors.ground,
    overflow: "hidden",
  },
  wrap: {
    flex: 1,
    width: "100%",
    maxWidth: 480,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
    justifyContent: "center",
    gap: 0,
  },
  mark: { alignSelf: "flex-start", marginBottom: 34 },
  markSuffix: { color: colors.muted },
  title: {
    fontFamily: fonts.display,
    fontWeight: "500",
    color: colors.text,
  },
  sub: {
    marginTop: 14,
    fontSize: 16,
    lineHeight: leading(16, 1.55),
  },
  card: {
    marginTop: 28,
    gap: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  error: { marginTop: -4 },
  actions: { gap: 14, alignItems: "flex-start" },
  foot: { marginTop: 26, lineHeight: leading(12.5, 1.6) },
});
