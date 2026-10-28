/**
 * The staff console's second step: an authenticator code, after the email
 * code that signed the person in (`functions/staffSecondFactor.ts`).
 *
 * Shown only to an allowlisted account whose standing is not `open`, and as a
 * one-line offer above the console to staff who have not enrolled yet. The
 * server decides every part of this; the screen only asks.
 */

import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, FormError, Text, TextField, space, useThemedStyles, type Colors } from "../design";

export interface StaffFactor {
  staff: true;
  enrolled: boolean;
  required: boolean;
  standing: "enroll" | "step_up" | "open";
  setupUri?: string;
  setupKey?: string;
}

const REASONS: Record<"wrong" | "wait" | "not_enrolling", { headline: string; next: string }> = {
  wrong: { headline: "That code didn't match", next: "Type the six digits your authenticator shows now." },
  wait: { headline: "Too many wrong codes", next: "Wait fifteen minutes, then try again." },
  not_enrolling: { headline: "Start setup on this device", next: "Press Set up an authenticator again." },
};

export function StaffFactorGate({ factor, offer = false }: { factor: StaffFactor; offer?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const start = useMutation(api.functions.staffSecondFactor.startEnrollment);
  const submit = useMutation(api.functions.staffSecondFactor.submitCode);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ headline: string; next: string } | null>(null);
  const [open, setOpen] = useState(!offer || factor.setupKey !== undefined);

  const enrolling = !factor.enrolled && factor.setupKey !== undefined;
  const stepUp = factor.enrolled;

  const begin = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await start({});
      setOpen(true);
    } catch {
      setProblem({ headline: "Could not start setup", next: "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await submit({ code });
      if (!result.ok) setProblem(REASONS[result.reason]);
      setCode("");
    } catch {
      setProblem({ headline: "Could not check that code", next: "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  if (offer && !open) {
    return (
      <View style={styles.offer} testID="staff-factor-offer">
        <Text variant="rowSub" style={styles.offerText}>
          Staff pages will need an authenticator code soon. Set one up now.
        </Text>
        <Button label="Set up" variant="mini" onPress={() => void begin()} disabled={busy} testID="staff-factor-begin" />
      </View>
    );
  }

  return (
    <View style={offer ? styles.offerOpen : styles.gate} testID="staff-factor-gate">
      <Text variant="paneTitle">{stepUp ? "Type your authenticator code" : "Set up an authenticator"}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {stepUp
          ? "Staff pages need a code from your authenticator app once per device, every twelve hours."
          : "Staff pages need a second step besides your email code: a code from an authenticator app."}
      </Text>
      {enrolling ? (
        <View style={styles.key}>
          <Text variant="rowSub">Add this key to your authenticator app, or open it on this phone.</Text>
          <Text variant="rowTitle" selectable style={styles.keyText} testID="staff-factor-key">
            {factor.setupKey!.replace(/(.{4})/g, "$1 ").trim()}
          </Text>
          {factor.setupUri ? (
            <Button label="Open in authenticator" variant="ghost" onPress={() => void Linking.openURL(factor.setupUri!)} />
          ) : null}
        </View>
      ) : null}
      {stepUp || enrolling ? (
        <>
          <TextField
            label="Six-digit code"
            value={code}
            onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            testID="staff-factor-code"
          />
          <Button label={busy ? "Checking…" : "Continue"} onPress={() => void send()} disabled={busy || code.length !== 6} testID="staff-factor-submit" />
        </>
      ) : (
        <Button label="Set up an authenticator" onPress={() => void begin()} disabled={busy} testID="staff-factor-begin" />
      )}
      {problem ? <FormError headline={problem.headline} next={problem.next} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    gate: { gap: space.x3, maxWidth: 420, alignSelf: "center", width: "100%", paddingVertical: space.x8 },
    offer: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    offerText: { flex: 1 },
    offerOpen: { gap: space.x3, paddingVertical: space.x3, borderBottomWidth: 1, borderBottomColor: colors.line },
    lede: { color: colors.text2 },
    key: { gap: space.x2 },
    keyText: { fontFamily: "monospace", letterSpacing: 1 },
  });
