import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { fonts, layout, leading, pointerType as t, radii, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { landAfterSignIn } from "./landing";
import { LANDING_ROUTE, safeNextRoute } from "./redirect";
import { normalizeSignInEmail, signInProviderForEmail } from "./email";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { SignInPreview } from "./SignInPreview";

/**
 * A-01 and A-02 — sign in, then the code.
 *
 * Two steps against `@convex-dev/auth`'s email provider, configured by
 * `createSupaAuth` in `apps/convex/auth.ts`, which sends a six-digit code that
 * expires in ten minutes — the only reason this screen may say either. There
 * is no password anywhere in the product.
 *
 * A `?next=` parameter survives the round trip, narrowed by `safeNextRoute` on
 * the way through. It exists for the consent screen: an AI client sends someone
 * to `/authorize?request_id=…`, and dropping them on the console afterwards
 * would strand the OAuth attempt with nothing to retry.
 *
 * On a wide window the form sits beside a picture of the product (A-01) or of
 * the email just sent (A-02); on a phone it is the form alone, because the
 * picture is decoration and the keyboard already takes half the screen.
 */
export function LoginScreen() {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
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
  const [resent, setResent] = useState(false);

  const wide = width >= 900;

  async function requestCode(again = false) {
    setError(null);
    setSubmitting(true);
    try {
      const normalized = normalizeSignInEmail(email);
      await signIn(signInProviderForEmail(normalized), { email: normalized });
      setStep("verify");
      setResent(again);
      if (again) setCode("");
    } catch {
      setError("Couldn't send your code. Check the address and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(value = code) {
    setError(null);
    setSubmitting(true);
    try {
      const normalized = normalizeSignInEmail(email);
      await signIn(signInProviderForEmail(normalized), {
        email: normalized,
        code: value.trim(),
      });
      // A real navigation on the web, not a client-side replace — see
      // `landAfterSignIn` for the URL that hop was measured losing.
      landAfterSignIn(next, (href) => router.replace(href));
    } catch {
      setError("That code didn't work. Codes expire after ten minutes — ask for a new one if it's been a while.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = step === "request" ? email.trim().length > 3 : code.trim().length === OTP_LENGTH;
  const spinner = submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  const form = (
    <View style={styles.form}>
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

      {step === "request" ? (
        <>
          <Text role="heading" aria-level={1} style={styles.pitch}>
            Tell one AI once. Every tool you allow starts already knowing your{" "}
            <Text style={[styles.pitch, styles.accent]}>projects, decisions, and history</Text>.
          </Text>
          <View style={styles.field}>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@work.com"
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
          </View>
        </>
      ) : (
        <>
          <Text role="heading" aria-level={1} style={styles.pitch}>
            Check your email.
          </Text>
          <Text variant="rowSub" style={styles.sent}>
            We sent a six-digit code to <Text style={styles.strong}>{email.trim()}</Text>. It expires in ten
            minutes.
          </Text>
          <Text variant="eyebrow" style={styles.label}>
            Code
          </Text>
          <CodeBoxes
            value={code}
            editable={!submitting}
            onChange={(value) => {
              setCode(value);
              setError(null);
              // The sixth digit is the submit: a person who typed the whole
              // code has said everything this screen asks for.
              if (value.length === OTP_LENGTH && !submitting) void verifyCode(value);
            }}
            testID="login-code"
          />
          {resent ? (
            <Text variant="foot" role="status" style={styles.resent}>
              A new code is on its way. The last one no longer works.
            </Text>
          ) : null}
        </>
      )}

      {error ? (
        <Text variant="error" role="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      {step === "request" ? (
        <View style={styles.primaryRow}>
          <Button
            label="Send a sign-in code"
            variant="white"
            disabled={submitting || !canSubmit}
            onPress={() => void requestCode()}
            trailing={spinner}
            testID="login-submit"
          />
        </View>
      ) : (
        <>
          <View style={styles.verifyRow}>
            <Button
              label="Resend code"
              variant="ghost"
              disabled={submitting}
              onPress={() => void requestCode(true)}
              testID="login-resend"
            />
            <Button
              label="Continue →"
              variant="white"
              disabled={submitting || !canSubmit}
              onPress={() => void verifyCode()}
              trailing={spinner}
              testID="login-submit"
            />
          </View>
          <Text
            variant="foot"
            role="link"
            style={styles.link}
            onPress={() => {
              if (submitting) return;
              setStep("request");
              setCode("");
              setError(null);
              setResent(false);
            }}
            testID="login-change-email"
          >
            Change email →
          </Text>
        </>
      )}

      <Text variant="foot" style={styles.foot}>
        {step === "request"
          ? "One code by email. No password to lose. Signing in creates an account in the control plane — it never moves a file."
          : "Next: pick the name your notes live under."}
      </Text>
    </View>
  );

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="login-page">
        <View style={[styles.frame, wide && styles.frameWide]}>
          <View style={[styles.formCol, wide && styles.formColWide]}>{form}</View>
          {wide ? (
            <View style={styles.previewCol}>
              <SignInPreview kind={step === "request" ? "product" : "email"} email={email.trim()} />
            </View>
          ) : null}
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
    frame: { width: "100%", alignSelf: "center" },
    frameWide: {
      maxWidth: 1180,
      flexDirection: "row",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      overflow: "hidden",
      backgroundColor: colors.surface2,
      marginVertical: space.x6,
    },
    formCol: {
      width: "100%",
      maxWidth: 480,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    formColWide: { flex: 1, maxWidth: undefined, paddingHorizontal: 46, paddingVertical: 60, justifyContent: "center" },
    previewCol: { flex: 1, minHeight: 560 },
    form: { maxWidth: 360 },
    mark: { alignSelf: "flex-start", marginBottom: 32 },
    markSuffix: { color: colors.accent },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    accent: { color: colors.accent },
    strong: { fontWeight: "600", color: colors.text },
    sent: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    label: { marginTop: space.x5, marginBottom: space.x2, color: colors.muted },
    field: { marginTop: space.x6 },
    resent: { marginTop: space.x3, color: colors.muted },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x5, alignSelf: "stretch" },
    verifyRow: { marginTop: space.x5, flexDirection: "row", justifyContent: "space-between", gap: space.x3 },
    link: { marginTop: space.x4, color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
    foot: { marginTop: space.x4, color: colors.muted, lineHeight: leading(12.5, 1.5) },
  });
