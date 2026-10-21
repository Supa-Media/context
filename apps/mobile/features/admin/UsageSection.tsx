/**
 * The Usage tab: visits to context.lc and tex.lc, time in the app, and the
 * pages and buttons people use most, for the console's 7 / 30 / 90 window.
 *
 * Everything here comes from PostHog through `usageAnalytics.report`, which
 * reads production only and returns hosts, cleaned routes, fixed button names
 * and counts. Presentational past `useUsageData`; the pieces are in
 * `./UsageParts` and the arithmetic in `./usage`.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { UsageAnalytics } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";
import { Button, Card, Text, space, useThemedStyles } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton, TwoUp } from "./AdminKit";
import { RankedPanel, SiteCard, TimeCard } from "./UsageParts";
import { buttonLabel, pageLabel } from "./usage";
import { UsageJourneys } from "./UsageJourneys";
import { useUsageData } from "./useUsageData";

export function UsageSection({ days }: { days: number }) {
  const [refresh, setRefresh] = useState(0);
  return <UsageView usage={useUsageData(days, refresh)} days={days} onRefresh={() => setRefresh((value) => value + 1)} />;
}

/** The tab for a given answer, exported so it can be drawn without Convex. */
export function UsageView({ usage, days, onRefresh }: { usage: UsageAnalytics | undefined; days: number; onRefresh?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  if (usage === undefined) return <Loading />;
  if (!usage.connected) {
    return (
      <Panel testID="admin-usage-unset">
        <EmptyNote
          tall
          title="PostHog isn't connected"
          body="Usage needs a private PostHog key with query:read permission and the existing project ID. The public tracking key cannot read metrics. Configure these on the server:"
          action={
            <View style={styles.envVars}>
              <Text variant="mono">POSTHOG_PERSONAL_API_KEY</Text>
              <Text variant="mono">POSTHOG_PROJECT_ID</Text>
              {onRefresh ? <Button label="Retry connection" variant="ghost" onPress={onRefresh} testID="admin-usage-retry" /> : null}
            </View>
          }
        />
      </Panel>
    );
  }
  if (usage.error !== null) {
    return (
      <Card style={styles.notice} testID="admin-usage-error">
        <NoticeLine mark="!" tone="warn">
          PostHog didn't answer: {usage.error}
        </NoticeLine>
        {onRefresh ? <Button label="Try again" variant="ghost" onPress={onRefresh} testID="admin-usage-retry" /> : null}
      </Card>
    );
  }

  const meta = (count: number) => (count >= 10 ? `top 10 · last ${days} days` : `last ${days} days`);
  return (
    <View style={styles.section} testID="admin-usage">
      {onRefresh ? <Button label="Refresh metrics" variant="ghost" onPress={onRefresh} testID="admin-usage-refresh" /> : null}
      <TwoUp>
        {usage.sites.map((site) => (
          <SiteCard key={site.host} site={site} days={days} />
        ))}
      </TwoUp>
      <TimeCard time={usage.time} prior={usage.priorTime} days={days} />
      <UsageJourneys funnels={usage.funnels} outcomes={usage.outcomes} days={days} />
      <TwoUp>
        <RankedPanel
          title="Most viewed pages"
          meta={meta(usage.pages.length)}
          valueLabel="Views"
          rows={usage.pages.map((row) => ({ key: row.route, label: pageLabel(row.route), value: row.views, people: row.people }))}
          empty={{ title: "No page views yet", body: "Screens are counted from each person's first visit." }}
          testID="admin-usage-pages"
          rowTestID={(key) => `admin-usage-page-${key}`}
        />
        <RankedPanel
          title="Most clicked buttons"
          meta={meta(usage.buttons.length)}
          valueLabel="Clicks"
          rows={usage.buttons.map((row) => ({ key: row.button, label: buttonLabel(row.button), value: row.clicks, people: row.people }))}
          empty={{ title: "No clicks yet", body: "Named buttons are counted from the first press." }}
          testID="admin-usage-buttons"
          rowTestID={(key) => `admin-usage-button-${key}`}
        />
      </TwoUp>
      <Text variant="meta">
        From PostHog · staging excluded · people who turned off screen counts are not in these figures
      </Text>
    </View>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} aria-busy testID="admin-usage-loading">
      <TwoUp>
        {[0, 1].map((index) => (
          <Card key={index} style={styles.loadingCard}>
            <Skeleton width={80} height={12} />
            <Skeleton width={140} height={30} style={styles.gap} />
            <Skeleton width="100%" height={112} style={styles.gap} />
            <View style={[styles.factsRow, styles.gap]}>
              {[0, 1, 2].map((cell) => (
                <Skeleton key={cell} width="30%" height={40} />
              ))}
            </View>
          </Card>
        ))}
      </TwoUp>
      <Card style={styles.loadingCard}>
        <Skeleton width={120} height={14} />
        <Skeleton width="100%" height={72} style={styles.gap} />
      </Card>
      <TwoUp>
        {[0, 1].map((index) => (
          <Card key={index} style={styles.loadingCard}>
            <Skeleton width={140} height={14} />
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} width="100%" height={32} style={styles.rowGap} />
            ))}
          </Card>
        ))}
      </TwoUp>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    section: { gap: space.x4 },
    notice: { paddingVertical: space.x3, paddingHorizontal: space.x4 },
    loadingCard: { gap: 6 },
    gap: { marginTop: 14 },
    rowGap: { marginTop: 10 },
    factsRow: { flexDirection: "row", justifyContent: "space-between" },
    envVars: { alignItems: "center", gap: 4 },
  });
