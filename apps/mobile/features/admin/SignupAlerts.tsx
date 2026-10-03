/**
 * "Email me about every signup": one switch per staff member, at the top of
 * the Waitlist tab. On, the server mails this person's own sign-in address for
 * each new waitlist signup and each brand-new account. See
 * `apps/convex/functions/signupAlerts.ts`.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Text, space, useThemedStyles } from "../design";
import { Switch } from "../design/components/Switch";
import { useCompact } from "./AdminKit";

export function SignupAlerts() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const alerts = useQuery(api.functions.admin.getSignupAlerts, {});
  const set = useMutation(api.functions.admin.setSignupAlerts);
  const [busy, setBusy] = useState(false);
  if (alerts === undefined) return null;

  async function onSwitch(on: boolean) {
    setBusy(true);
    try {
      await set({ on });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, compact && styles.rowCompact]} testID="admin-signup-alerts">
      <View style={styles.words}>
        <Text variant="rowTitle">Email me about every signup</Text>
        <Text variant="meta">New waitlist signups and new accounts, sent to {alerts.email}.</Text>
      </View>
      <Switch
        label="Email me about every signup"
        value={alerts.on}
        onValueChange={onSwitch}
        disabled={busy}
        testID="admin-signup-alerts-switch"
      />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    rowCompact: { alignItems: "flex-start" },
    words: { flexShrink: 1, gap: 2 },
  });
