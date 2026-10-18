/**
 * The Features tab: built features staff open to everyone, or close again,
 * without a deploy. One switch per feature; the list and the words are the
 * server's (`apps/convex/functions/lib/featureSwitches.ts`), so a feature
 * added there shows here with nothing to change in the app.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Text, space, useThemedStyles } from "../design";
import { Switch } from "../design/components/Switch";
import { Panel, Skeleton, useCompact } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { relativeTime } from "./report";

export function FeaturesSection() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const features = useQuery(api.functions.featureSwitches.listFeatureSwitches, {});
  const set = useMutation(api.functions.featureSwitches.setFeatureSwitch);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSwitch(key: string, on: boolean) {
    setBusy(key);
    setProblem(null);
    try {
      await set({ key, on });
    } catch (error: unknown) {
      setProblem(messageFor(error, "That switch did not change. Try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Features" help="Built and on production, open to everyone only while switched on. A switch takes effect on the next request.">
      {features === undefined ? (
        <Skeleton width="100%" height={56} />
      ) : (
        features.map((feature) => (
          <View key={feature.key} style={[styles.row, compact && styles.rowCompact]} testID={`admin-feature-${feature.key}`}>
            <View style={styles.words}>
              <Text variant="rowTitle">{feature.label}</Text>
              <Text variant="meta">{feature.description}</Text>
              {feature.updatedAt === null ? null : (
                <Text variant="meta">
                  Switched {feature.on ? "on" : "off"} {relativeTime(feature.updatedAt)}
                </Text>
              )}
            </View>
            <Switch
              label={feature.label}
              value={feature.on}
              onValueChange={(on) => void onSwitch(feature.key, on)}
              disabled={busy !== null}
              testID={`admin-feature-${feature.key}-switch`}
            />
          </View>
        ))
      )}
      {problem === null ? null : <Text variant="meta">{problem}</Text>}
    </Panel>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3, paddingVertical: space.x2 },
    rowCompact: { alignItems: "flex-start" },
    words: { flexShrink: 1, gap: 2 },
  });
