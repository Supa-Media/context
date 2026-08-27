import { StyleSheet, View, type ViewStyle } from "react-native";
import { Card } from "../design/components/Card";
import { Fact } from "../design/components/Fact";
import { Pill } from "../design/components/Pill";
import { Text } from "../design/components/Text";
import { leading } from "../design/tokens";
import { CONTEXT_OVERVIEW_FACTS, CONTEXT_OVERVIEW_FOOT } from "./copy";

/**
 * What Context is, for a signed-in stranger.
 *
 * Presentational and nothing else — no data, no router, no session. It exists
 * because of one moment: somebody is sent an invitation link by a colleague,
 * signs in for the first time, and is asked to join a context belonging to a
 * product they have never used. Every other screen in the app is for people who
 * already know what this is; that person has thirty seconds and one question.
 *
 * Six lines, from `copy.ts`, which is also where the two claims that are
 * product invariants rather than marketing live.
 */
export function ContextOverview({
  style,
  testID = "context-overview",
}: {
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <View style={style} testID={testID}>
      <Text variant="eyebrow">What Context is</Text>
      <Card style={styles.card}>
        {CONTEXT_OVERVIEW_FACTS.map((fact) => (
          <Fact
            key={fact.title}
            title={fact.title}
            body={fact.body}
            trailing={
              fact.status === undefined ? null : <Pill tone="neutral">{fact.status}</Pill>
            }
          />
        ))}
      </Card>
      <Text variant="foot" style={styles.foot}>
        {CONTEXT_OVERVIEW_FOOT}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 9, gap: 13 },
  foot: { marginTop: 10, lineHeight: leading(12.5, 1.6) },
});
