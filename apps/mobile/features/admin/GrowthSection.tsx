/**
 * The Growth tab: is anybody new here, and who is stuck.
 *
 * Two headline cards, one per figure the page was asked for. Each **is** its
 * figure — the total, the window's arrivals and the change on the window
 * before, then the curve, then three facts — so both cards end on the same
 * structure and are the same height by construction. The four-tile strip that
 * used to sit above them is gone: its Accounts and Contexts moved into the
 * cards, and saying one number twice is how a page starts to disagree with
 * itself. Paying and Active are a slim two-figure strip under them.
 *
 * Below: the funnel beside "Needs a nudge", which is the same roster read
 * person by person, then the roster itself.
 */

import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  Button,
  Card,
  Dot,
  Text,
  leading,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType } from "../design/tokens";
import {
  EmptyNote,
  Panel,
  Skeleton,
  TruncatedNotice,
  TwoUp,
  useCompact,
  usePanelPad,
} from "./AdminKit";
import { ListRow, RowValue } from "./AdminTable";
import { FunnelChart } from "./Charts";
import { arrivalDays, daysSinceLastArrival, formatDaysAgo, nudgeCounts } from "./growth";
import { Curve, HeadlineCard, PairStrip } from "./HeadlineCard";
import { formatCount, formatMoney, formatRatio, formatTotal, funnelRows } from "./report";
import { RosterCard } from "./RosterCard";

export function GrowthSection({
  days,
  unsetCount,
  onCredentials,
}: {
  days: number;
  unsetCount: number;
  onCredentials: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const census = useQuery(api.functions.admin.censusReport, { days });
  const usage = useQuery(api.functions.admin.usageReport, { days });
  const funnel = useMemo(() => (census ? funnelRows(census.funnel) : []), [census]);

  if (census === undefined) return <GrowthSkeleton />;

  const { accounts, contexts, truncated } = census;
  const windowDays = accounts.added.length;
  const nobody = accounts.total.count === 0 && !truncated;
  const both = contexts.personal + contexts.shared;

  const accountsCard = (
    <HeadlineCard
      label="Accounts"
      value={formatTotal(accounts.total)}
      newInWindow={accounts.newInWindow}
      newInPrior={accounts.newInPriorWindow}
      days={census.days}
      chart={
        <Curve
          truncated={truncated}
          empty={nobody ? "Nobody has signed up yet" : null}
          cumulative={accounts.cumulative}
          added={accounts.added}
          testID="admin-curve-accounts"
        />
      }
      facts={[
        {
          label: "Days with arrivals",
          short: "Arrival days",
          // A count of days needs every day's rows; a truncated census has
          // an arbitrary slice of them. Same rule as the curve.
          value: truncated ? "—" : formatCount(arrivalDays(accounts.added)),
          unit: truncated ? undefined : `of ${windowDays}`,
        },
        {
          label: "Last arrival",
          value: truncated ? "—" : formatDaysAgo(daysSinceLastArrival(accounts.added)),
        },
        { label: "Contexts each", value: formatRatio(contexts.perAccount) },
      ]}
      testID="admin-stat-accounts"
    />
  );

  const contextsCard = (
    <HeadlineCard
      label="Contexts"
      value={formatTotal(contexts.total)}
      newInWindow={contexts.newInWindow}
      newInPrior={contexts.newInPriorWindow}
      days={census.days}
      chart={
        <Curve
          truncated={truncated}
          empty={nobody ? "No contexts yet" : null}
          cumulative={contexts.cumulative}
          added={contexts.added}
          testID="admin-curve-contexts"
        />
      }
      facts={[
        {
          label: "Personal",
          value: formatCount(contexts.personal),
          share: { part: both > 0 ? contexts.personal / both : 0, tone: "accent" },
        },
        {
          label: "Shared",
          value: formatCount(contexts.shared),
          share: { part: both > 0 ? contexts.shared / both : 0, tone: "shared" },
        },
        {
          label: "Members per shared",
          short: "Per shared",
          value: formatRatio(contexts.membersPerShared),
        },
      ]}
      testID="admin-stat-contexts"
    />
  );

  const activeToday =
    usage?.activeContexts.points[usage.activeContexts.points.length - 1]?.count ?? null;

  return (
    <View style={styles.section}>
      <TruncatedNotice truncated={truncated} />
      <TwoUp>
        {accountsCard}
        {contextsCard}
      </TwoUp>
      <PairStrip
        cells={[
          {
            label: "Paying contexts",
            caption: `${formatMoney(census.plans.mrrCents)} a month`,
            value: formatCount(census.plans.paying),
            ok: census.plans.paying > 0,
            testID: "admin-stat-paying",
          },
          {
            label: "Active contexts",
            caption:
              activeToday === null ? `in the last ${days} days` : `${formatCount(activeToday)} today`,
            value: usage === undefined ? "…" : formatCount(usage.activeContexts.distinctInWindow),
            testID: "admin-stat-active",
          },
        ]}
      />
      {nobody ? (
        <Panel testID="admin-roster">
          <EmptyNote
            tall
            title="Nobody has signed up yet"
            body="The funnel and the account list fill in as people arrive."
            action={
              unsetCount > 0 ? (
                <Button
                  label={`Set up ${unsetCount} integration credential${unsetCount === 1 ? "" : "s"}`}
                  onPress={onCredentials}
                  testID="admin-empty-credentials"
                />
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <>
          <TwoUp>
            <Panel
              title="How far accounts get"
              meta="of everyone who signed up"
              metaWide
              help="Thresholds, not a nested funnel. A step can be larger than the one above it — a client connected to a context whose bucket never verified — and that is the customer to go and talk to."
              style={styles.fill}
              testID="admin-funnel"
            >
              <FunnelChart rows={funnel} />
            </Panel>
            <NudgeCard roster={census.roster} />
          </TwoUp>
          <RosterCard roster={census.roster} total={formatTotal(accounts.total)} />
        </>
      )}
    </View>
  );
}

// -- needs a nudge --------------------------------------------------------

/**
 * The questions the funnel raises and cannot answer, because its steps are
 * thresholds over everybody: the same roster, read person by person. Over the
 * newest accounts the server sent, not all of them, and the card says so.
 */
function NudgeCard({ roster }: { roster: Parameters<typeof nudgeCounts>[0] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  if (roster.length === 0) {
    return (
      <Panel title="Needs a nudge" style={styles.fill} testID="admin-nudge">
        <EmptyNote title="Nothing yet" body="Accounts that stall at a step will be listed here." />
      </Panel>
    );
  }
  const counts = nudgeCounts(roster);
  const lines: { key: string; label: string; count: number; tone: "warn" | "crit" }[] = [
    { key: "storage", label: "No storage connected", count: counts.noStorage, tone: "warn" },
    { key: "client", label: "No client connected", count: counts.noClient, tone: "warn" },
    { key: "seen", label: "Never came back", count: counts.neverSeen, tone: "warn" },
    { key: "due", label: "Payment past due", count: counts.pastDue, tone: "crit" },
  ];
  return (
    <Panel
      title="Needs a nudge"
      meta={`of the ${formatCount(roster.length)} newest`}
      style={styles.fill}
      testID="admin-nudge"
    >
      <View style={{ marginHorizontal: -pad.x, marginBottom: -pad.y }}>
        {lines.map((line, index) => (
          <ListRow
            key={line.key}
            first={index === 0}
            title={
              <View style={styles.nudgeTitle}>
                <Dot tone={line.count > 0 ? line.tone : "neutral"} size={7} />
                <Text variant="check" style={[styles.nudgeLabel, compact && styles.nudgeCompact]}>
                  {line.label}
                </Text>
              </View>
            }
            trailing={<RowValue>{formatCount(line.count)}</RowValue>}
            testID={`admin-nudge-${line.key}`}
          />
        ))}
      </View>
    </Panel>
  );
}

// -- loading --------------------------------------------------------------

/** The shape of the tab, in blocks, while the census is on its way. */
function GrowthSkeleton() {
  const styles = useThemedStyles(makeStyles);
  const card = (
    <Card style={styles.fill}>
      <View style={styles.head}>
        <View style={styles.skStack}>
          <Skeleton width={70} height={12} />
          <Skeleton width={56} height={30} />
        </View>
        <View style={[styles.skStack, styles.headRight]}>
          <Skeleton width={110} height={12} />
          <Skeleton width={130} height={12} />
        </View>
      </View>
      <Skeleton width="100%" height={132} />
    </Card>
  );
  return (
    <View style={styles.section} aria-busy testID="admin-loading">
      <TwoUp>
        {card}
        {card}
      </TwoUp>
      <Card>
        <Skeleton width={120} height={14} />
        <Skeleton width="100%" height={140} style={styles.skGap} />
      </Card>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    fill: { flexGrow: 1 },

    head: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
      gap: space.x3,
      marginBottom: 14,
    },
    headRight: { alignItems: "flex-end" },
    nudgeTitle: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    nudgeLabel: { color: colors.text, flexShrink: 1 },
    nudgeCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.5) },

    skStack: { gap: space.x2 },
    skGap: { marginTop: 18 },
  });
