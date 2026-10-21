import { StyleSheet, View } from "react-native";
import { USAGE_FUNNELS, USAGE_STEP_LABELS, isUsageOutcome, type UsageStepId } from "@context/shared";
import type { UsageFunnel, UsageOutcome } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, Panel, TwoUp } from "./AdminKit";
import { RankedPanel } from "./UsageParts";
import { formatCount } from "./report";

/** A funnel counts merged people in order, not unrelated event totals. */
export function UsageJourneys({ funnels, outcomes, days }: {
  funnels?: UsageFunnel[]; outcomes?: UsageOutcome[]; days: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const cards = USAGE_FUNNELS.flatMap((definition) => {
    const value = funnels?.find((funnel) => funnel.id === definition.id);
    return value ? [{ definition, value }] : [];
  });
  const issueLabels: Readonly<Record<string, string>> = {
    failed: "Failed", unavailable: "Unavailable", invalid_phone: "Invalid number", too_many: "Too many requests",
    paused: "Paused", limited: "Rate limited", timeout: "Timed out", queued: "Queued offline",
  };
  const eventLabels: Readonly<Record<string, string>> = {
    signup_result: "Signup", signin_code_result: "Sign-in code", note_save_result: "Note save",
  };
  const issues = (outcomes ?? []).filter((row) => isUsageOutcome(row.event, row.result) && Object.prototype.hasOwnProperty.call(issueLabels, row.result))
    .sort((a, b) => b.attempts - a.attempts);
  return (
    <View style={styles.section}>
      {Array.from({ length: Math.ceil(cards.length / 2) }, (_, index) => (
        <TwoUp key={index}>
          {cards.slice(index * 2, index * 2 + 2).map(({ definition, value }) => (
            <FunnelCard key={definition.id} definition={definition} value={value} />
          ))}
        </TwoUp>
      ))}
      {outcomes === undefined ? null : (
        <RankedPanel
          title="Failures and pending saves"
          meta={`last ${days} days · attempts, not unique failures`}
          valueLabel="Attempts"
          itemLabel="Outcome"
          rows={issues.map((row) => ({
            key: `${row.event}:${row.result}`, label: `${eventLabels[row.event]} · ${issueLabels[row.result]}`,
            value: row.attempts, people: row.people,
          }))}
          empty={{ title: "No failures recorded", body: "Failed signup, verification and saves appear here. Offline saves are pending, not failed." }}
          testID="admin-usage-outcomes"
          rowTestID={(key) => `admin-usage-outcome-${key}`}
        />
      )}
    </View>
  );
}

function FunnelCard({ definition, value }: { definition: typeof USAGE_FUNNELS[number]; value: UsageFunnel }) {
  const styles = useThemedStyles(makeStyles);
  const steps = definition.steps.map((key) => ({ key, people: value.steps.find((step) => step.key === key)?.people ?? 0 }));
  const first = steps[0]?.people ?? 0;
  const window = definition.windowSeconds === 1800 ? "30 minutes" : "24 hours";
  return (
    <Panel
      title={definition.title}
      meta={`within ${window}`}
      help={`Unique people reaching each step in order within ${window}. Percentages use the first step as the denominator. Recent visits can still progress. Only visits with the full journey tracking are included; earlier traffic is excluded. A Messages click does not mean a text was sent.`}
      style={styles.card}
      testID={`admin-usage-funnel-${definition.id}`}
    >
      {first === 0 ? <EmptyNote title="No funnel events yet" body="This journey starts counting with fully tracked visits. Earlier traffic still appears above." /> : steps.map((step, index) => {
        const percentage = Math.min(100, Math.max(0, Math.round(step.people / first * 100)));
        const gap = index === 0 ? null : Math.max(0, (steps[index - 1]?.people ?? 0) - step.people);
        return (
          <View key={step.key} style={styles.stage} testID={`admin-usage-funnel-${definition.id}-${step.key}`}>
            <View style={styles.row}>
              <View style={styles.name}>
                <Text variant="rowTitle">{USAGE_STEP_LABELS[step.key as UsageStepId]}</Text>
                {gap === null ? null : <Text variant="meta">{formatCount(gap)} not yet progressed from the previous step</Text>}
              </View>
              <View style={styles.figure}>
                <Text variant="rowTitle">{formatCount(step.people)}</Text>
                <Text variant="meta">{percentage}%</Text>
              </View>
            </View>
            <View style={styles.track} aria-hidden><View style={[styles.fill, { width: `${percentage}%` }]} /></View>
          </View>
        );
      })}
    </Panel>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  section: { gap: space.x4 }, card: { flexGrow: 1 }, stage: { gap: 8, marginBottom: space.x3 },
  row: { flexDirection: "row", gap: space.x3, alignItems: "flex-start" }, name: { flex: 1, gap: 3 },
  figure: { alignItems: "flex-end", minWidth: 42, gap: 3 },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: colors.accent },
});
