/**
 * The storage line at the top of Search › Indexes: how far every bucket is
 * behind its file tree and when it catches up, and the caller's "Email me
 * when storage falls behind" switch (`apps/convex/functions/storageLag.ts`).
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Switch } from "../design/components/Switch";
import { useCompact } from "./AdminKit";
import { lagLine, type MovesLag } from "./storageLag";

export function StorageLag({ lag }: { lag: MovesLag }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const alerts = useQuery(api.functions.storageLag.getAlerts, {});
  const set = useMutation(api.functions.storageLag.setAlerts);
  const [busy, setBusy] = useState(false);
  const line = lagLine(lag);

  async function onSwitch(on: boolean) {
    setBusy(true);
    try {
      await set({ on });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, compact && styles.rowCompact]} testID="admin-storage-lag">
      <View style={styles.words}>
        <Text variant="rowTitle" style={line.tone === "crit" ? styles.crit : undefined}>
          {line.text}
        </Text>
        {alerts ? (
          <Text variant="meta">
            Email me when storage falls behind: a move 4 hours old, on pace to miss 5, or stuck. Sent to {alerts.email}.
          </Text>
        ) : null}
      </View>
      {alerts ? (
        <Switch
          label="Email me when storage falls behind"
          value={alerts.on}
          onValueChange={onSwitch}
          disabled={busy}
          testID="admin-storage-lag-switch"
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    rowCompact: { alignItems: "flex-start" },
    words: { flexShrink: 1, gap: 2 },
    crit: { color: colors.critText },
  });
