import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { fonts, layout, leading, pointerType as t, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { resetObservabilityUser } from "../observability/client";
import { confirmError, startError } from "../console/settings/panels/signInEmails";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";

export const EMAIL_CHECK_TITLE = "What's your email?";
export const EMAIL_CHECK_WHY = "Mail goes here, like invites and updates. You'll keep signing in with your phone.";

/**
 * Asked once of an account a phone made (a number staff let in from the
 * waitlist, Dev2 2026-10-09), before anything else it sees: the address mail
 * and invitations go to, confirmed with a mailed code. Drawn by
 * `app/(app)/_layout.tsx` in place of every route, like the phone check.
 *
 * An address that already has its own Context account means the person was
 * here already: their new, empty phone account folds into that one, phone
 * and all (`functions/signInEmails.ts`, "moved"), and they sign in again with
 * the phone to land there.
 */
export function EmailCheckScreen() {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { signOut } = useAuthActions();
  const startAdd = useAction(api.functions.signInEmails.startAddEmail);
  const confirmAdd = useAction(api.functions.signInEmails.confirmAddEmail);

  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startAdd({ email: sentTo ?? email });
      setError(startError(result.status));
      if (result.status === "sent" && result.email !== undefined) {
        setSentTo(result.email);
        setCode("");
      }
    } catch {
      setError(startError("failed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (value = code) => {
    if (busy || value.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmAdd({ code: value });
      setError(confirmError(result.status));
      if (result.status === "moved") setMoved(true);
      else if (result.status !== "added") setCode("");
    } catch {
      setError(confirmError("failed"));
    } finally {
      setBusy(false);
    }
  };

  const signInAgain = () => {
    void (async () => {
      await signOut();
      resetObservabilityUser();
      router.replace("/login");
    })();
  };

  const spinner = busy ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="email-check">
        <View style={styles.form}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {moved ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Welcome back.
              </Text>
              <Text variant="rowSub" style={styles.body}>
                <Text style={styles.strong}>{sentTo}</Text> already had a Context account, so your phone is on it now.
                Sign in again with your phone to open it.
              </Text>
              <View style={styles.primaryRow}>
                <Button label="Sign in again" variant="accent" onPress={signInAgain} testID="email-check-sign-in" />
              </View>
            </>
          ) : sentTo === null ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                {EMAIL_CHECK_TITLE}
              </Text>
              <Text variant="rowSub" style={styles.body}>
                {EMAIL_CHECK_WHY}
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
                  editable={!busy}
                  onSubmitEditing={() => void send()}
                  testID="email-check-address"
                />
              </View>
            </>
          ) : (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Check your email.
              </Text>
              <Text variant="rowSub" style={styles.body}>
                We sent a six-digit code to <Text style={styles.strong}>{sentTo}</Text>.
              </Text>
              <Text variant="eyebrow" style={styles.label}>
                Code
              </Text>
              <CodeBoxes
                value={code}
                editable={!busy}
                onChange={(value) => {
                  setCode(value);
                  if (value.length === OTP_LENGTH) void confirm(value);
                }}
                testID="email-check-code"
              />
            </>
          )}

          {error ? (
            <Text variant="error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          {moved ? null : sentTo === null ? (
            <View style={styles.primaryRow}>
              <Button
                label="Email me a code"
                variant="accent"
                disabled={busy || email.trim() === ""}
                onPress={() => void send()}
                trailing={spinner}
                testID="email-check-send"
              />
            </View>
          ) : (
            <>
              <View style={styles.verifyRow}>
                <Button
                  label="Send a new code"
                  variant="decision"
                  disabled={busy}
                  onPress={() => void send()}
                  testID="email-check-resend"
                />
                <Button
                  label="Continue →"
                  variant="accent"
                  disabled={busy || code.length !== OTP_LENGTH}
                  onPress={() => void confirm()}
                  trailing={spinner}
                  testID="email-check-confirm"
                />
              </View>
              <Text
                variant="foot"
                role="link"
                style={styles.link}
                onPress={() => {
                  setSentTo(null);
                  setCode("");
                  setError(null);
                }}
                testID="email-check-change"
              >
                Use a different email
              </Text>
            </>
          )}
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    form: {
      width: "100%",
      maxWidth: 400,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    mark: { marginBottom: 32 },
    markSuffix: { color: colors.accent },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    body: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    field: { marginTop: space.x6 },
    label: { marginTop: space.x5, marginBottom: space.x2, color: colors.muted },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x5, alignSelf: "stretch" },
    verifyRow: { marginTop: space.x5, flexDirection: "row", justifyContent: "space-between", gap: space.x3 },
    link: { marginTop: space.x4, color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
  });
