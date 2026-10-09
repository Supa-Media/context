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
import { forgetLocalCopies, unsentOnDevice } from "../offline/forget";
import { resetObservabilityUser } from "../observability/client";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { JOINED_BODY, JOINED_TITLE, PHONE_CHECK_TITLE, PHONE_CHECK_WHY, confirmError, sendError } from "./phoneCheck";

/**
 * The phone check (Dev2, 2026-10-09): one screen in front of the whole app
 * until this account has confirmed a phone with a texted code. Drawn by
 * `app/(app)/_layout.tsx` in place of every route, so there is no way round it
 * in the app; AI connections are not affected.
 *
 * Two steps, like sign-in: the number, then the code. Once the code is
 * confirmed the layout's subscription answers "not required" and the app
 * draws on its own; this screen does not navigate.
 *
 * A number another account already holds joins the two when this one owns
 * nothing ("joined", `lib/account/phoneJoin.ts`): this account closes into
 * that one, so the screen says so and the person signs in again to land there.
 */
export function PhoneCheckScreen({ initialSentTo }: { initialSentTo?: string } = {}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { signOut } = useAuthActions();
  const sendCode = useAction(api.functions.phoneCheck.sendPhoneCode);
  const confirmCode = useAction(api.functions.phoneCheck.confirmPhoneCode);

  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(initialSentTo ?? null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendCode({ phone: sentTo ?? phone });
      setError(sendError(result.status));
      if (result.status === "sent" && result.phone !== undefined) {
        setSentTo(result.phone);
        setCode("");
      }
    } catch {
      setError(sendError("failed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (value = code) => {
    if (busy || sentTo === null || value.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmCode({ phone: sentTo, code: value });
      setError(confirmError(result.status));
      if (result.status === "joined") setJoined(true);
      else if (result.status !== "confirmed") setCode("");
    } catch {
      setError(confirmError("failed"));
    } finally {
      setBusy(false);
    }
  };

  const useAnotherAccount = () => {
    void (async () => {
      // Edits still waiting to sync stay on the device for the next sign-in
      // rather than being dropped by a sign-out from this screen.
      const unsent = await unsentOnDevice(null);
      if (unsent.pending + unsent.conflicted + unsent.rejected === 0) await forgetLocalCopies();
      await signOut();
      resetObservabilityUser();
      router.replace("/");
    })();
  };

  const spinner = busy ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="phone-check">
        <View style={styles.form}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {joined ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                {JOINED_TITLE}
              </Text>
              <Text variant="rowSub" style={styles.body}>
                {JOINED_BODY}
              </Text>
              <View style={styles.primaryRow}>
                <Button label="Sign in again" variant="accent" onPress={useAnotherAccount} testID="phone-check-sign-in" />
              </View>
            </>
          ) : sentTo === null ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                {PHONE_CHECK_TITLE}
              </Text>
              <Text variant="rowSub" style={styles.body}>
                {PHONE_CHECK_WHY}
              </Text>
              <View style={styles.field}>
                <TextField
                  label="Phone number"
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="+1 555 555 0100"
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  editable={!busy}
                  onSubmitEditing={() => void send()}
                  testID="phone-check-number"
                />
              </View>
            </>
          ) : (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Check your texts.
              </Text>
              <Text variant="rowSub" style={styles.body}>
                We sent a code to <Text style={styles.strong}>{sentTo}</Text>.
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
                testID="phone-check-code"
              />
            </>
          )}

          {error ? (
            <Text variant="error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          {joined ? null : sentTo === null ? (
            <View style={styles.primaryRow}>
              <Button
                label="Text me a code"
                variant="accent"
                disabled={busy || phone.trim() === ""}
                onPress={() => void send()}
                trailing={spinner}
                testID="phone-check-send"
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
                  testID="phone-check-resend"
                />
                <Button
                  label="Continue →"
                  variant="accent"
                  disabled={busy || code.length !== OTP_LENGTH}
                  onPress={() => void confirm()}
                  trailing={spinner}
                  testID="phone-check-confirm"
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
                testID="phone-check-change"
              >
                Use a different number
              </Text>
            </>
          )}

          {joined ? null : (
            <Text
              variant="foot"
              role="link"
              style={styles.signOut}
              onPress={useAnotherAccount}
              testID="phone-check-sign-out"
            >
              Sign out
            </Text>
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
    signOut: { marginTop: space.x6, color: colors.muted, textDecorationLine: "underline" },
  });
