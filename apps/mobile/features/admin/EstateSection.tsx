/**
 * The Estate tab: what we hold, what we are paid, who is connected.
 *
 * Every figure the old tab had is still here. What moved is the prose: each
 * card opened with a twenty-to-forty-word paragraph that was important once
 * and noise on every visit after. The security-relevant sentences — which
 * buckets count as ours, that a client's name is unauthenticated — survive in
 * the `?` beside the title, and the client caveat also stays visible in short.
 */

import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card, Notice, Pill, Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import {
  EmptyNote,
  NoticeLine,
  Panel,
  Skeleton,
  TruncatedNotice,
  TwoUp,
  useCompact,
  usePanelPad,
} from "./AdminKit";
import {
  ListRow,
  RowValue,
  TableHead,
  TableRow,
  type Column,
} from "./AdminTable";
import { CompositionBar } from "./Charts";
import {
  bindingStatusLabel,
  bindingStatusTone,
  compositionOf,
  formatCount,
  formatLastUsed,
  formatMoney,
  providerLabel,
} from "./report";

const PROVIDER_COLUMNS: readonly Column[] = [
  { label: "Provider", flex: 2 },
  { label: "Ours", flex: 1, align: "right" },
  { label: "Theirs", flex: 1, align: "right" },
  { label: "Total", flex: 1, align: "right" },
];

const CLIENT_COLUMNS: readonly Column[] = [
  { label: "Client", flex: 2 },
  { label: "Live grants", flex: 1, align: "right" },
  { label: "Contexts", flex: 1, align: "right" },
  { label: "Accounts", flex: 1, align: "right" },
  { label: "Revoked", flex: 1, align: "right" },
  { label: "Last used", flex: 1 },
];

export function EstateSection({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  const census = useQuery(api.functions.admin.censusReport, { days });

  const storage = useMemo(
    () =>
      census
        ? compositionOf([
            { key: "managed", label: "Managed by us", count: census.storage.managed, tone: "accent" as const },
            { key: "customer", label: "Customer's own bucket", count: census.storage.customer, tone: "ok" as const },
            { key: "unbound", label: "No bucket yet", count: census.storage.unbound, tone: "warn" as const },
          ])
        : [],
    [census],
  );

  const plans = useMemo(
    () =>
      census
        ? compositionOf([
            { key: "active", label: "Paying", count: census.plans.paying, tone: "ok" as const },
            { key: "past_due", label: "Past due", count: census.plans.pastDue, tone: "crit" as const },
            { key: "canceled", label: "Cancelled", count: census.plans.canceled, tone: "warn" as const },
            { key: "free", label: "Free", count: census.plans.free, tone: "muted" as const },
          ])
        : [],
    [census],
  );

  if (census === undefined) return <EstateSkeleton />;

  const s = census.storage;
  const p = census.plans;
  const src = census.sources;
  const bleed = { marginHorizontal: -pad.x };

  return (
    <View style={styles.section}>
      <TruncatedNotice truncated={census.truncated} />

      <TwoUp>
        <Panel
          title="Storage"
          meta={`${formatCount(s.managed + s.customer + s.unbound)} contexts`}
          help="A bucket counts as ours only when its whole name is the one we derive from the context's id. A customer's own bucket that happens to start with our prefix is theirs."
          style={styles.fill}
          testID="admin-storage"
        >
          <CompositionBar segments={storage} empty="No contexts yet." />
          <View style={styles.chips}>
            {s.byStatus.map((entry) => (
              <Pill key={entry.status} tone={bindingStatusTone(entry.status)}>
                {bindingStatusLabel(entry.status)} {formatCount(entry.count)}
              </Pill>
            ))}
            {s.byStatus.length === 0 ? <Text variant="meta">No bindings yet.</Text> : null}
          </View>
          {s.byProvider.length > 0 ? (
            <View style={[styles.providers, bleed, { marginBottom: -pad.y }]}>
              <TableHead columns={PROVIDER_COLUMNS} />
              {s.byProvider.map((entry, index) => (
                <TableRow
                  key={entry.provider}
                  columns={PROVIDER_COLUMNS}
                  last={index === s.byProvider.length - 1}
                  testID={`admin-provider-${entry.provider}`}
                  cells={[
                    <Text key="name" variant="check">
                      {providerLabel(entry.provider)}
                    </Text>,
                    <Text key="ours" variant="meta" style={styles.num}>
                      {formatCount(entry.managed)}
                    </Text>,
                    <Text key="theirs" variant="meta" style={styles.num}>
                      {formatCount(entry.customer)}
                    </Text>,
                    <Text key="total" style={styles.strongNum}>
                      {formatCount(entry.managed + entry.customer)}
                    </Text>,
                  ]}
                />
              ))}
            </View>
          ) : null}
        </Panel>

        <Panel
          title="Subscriptions"
          meta={`${formatCount(p.paying)} paying at the one price`}
          metaWide
          style={styles.fill}
          testID="admin-plans"
        >
          <View style={styles.minis}>
            <Mini
              label="MRR"
              value={formatMoney(p.mrrCents)}
              caption={`a month · ${formatCount(p.paying)} paying`}
              ok={p.mrrCents > 0}
              testID="admin-stat-mrr"
            />
            <Mini label="Managed storage" value={formatCount(p.servingManagedStorage)} caption="selected & paid" />
            <Mini label="Fast search" value={formatCount(p.servingFastSearch)} caption="selected & paid" />
          </View>
          <View style={styles.gapTop}>
            <CompositionBar segments={plans} empty="No contexts yet." />
          </View>
          {p.provisioningRunning + p.provisioningFailed > 0 ? (
            <Notice
              tone={p.provisioningFailed > 0 ? "warn" : "neutral"}
              style={styles.gapTop}
              testID="admin-provisioning"
            >
              <NoticeLine mark={p.provisioningFailed > 0 ? "!" : "·"} tone={p.provisioningFailed > 0 ? "warn" : "neutral"}>
                <Text variant="check" style={styles.strong}>
                  {formatCount(p.provisioningFailed)} managed bucket
                  {p.provisioningFailed === 1 ? "" : "s"} failed
                </Text>
                , {formatCount(p.provisioningRunning)} being created. A failure is somebody who
                has paid and has nothing yet.
              </NoticeLine>
            </Notice>
          ) : null}
          {p.unresolved > 0 ? (
            <Text variant="meta" style={styles.unresolved}>
              {formatCount(p.unresolved)} with a subscription status this build does not
              recognise — serving nothing.
            </Text>
          ) : null}
        </Panel>
      </TwoUp>

      <Panel
        flush
        title="Connected clients"
        meta="names are self-reported"
        help="One row per OAuth client holding a live grant. Names are what each client called itself at registration, which is unauthenticated — treat them as a label, not an identity."
        testID="admin-clients"
      >
        {census.clients.length === 0 ? (
          <EmptyNote title="Nothing is connected yet" body="Clients appear once someone grants one access." />
        ) : compact ? (
          census.clients.map((client, index) => (
            <ListRow
              key={client.clientId}
              first={index === 0}
              title={client.clientName}
              sub={`${plural(client.contexts, "context")} · ${plural(client.accounts, "account")} · ${formatLastUsed(
                client.lastUsedAt,
              )}${client.revoked > 0 ? ` · ${formatCount(client.revoked)} revoked` : ""}`}
              trailing={<RowValue>{formatCount(client.active)}</RowValue>}
              testID={`admin-client-${client.clientId}`}
            />
          ))
        ) : (
          <View>
            <TableHead columns={CLIENT_COLUMNS} />
            {census.clients.map((client, index) => (
              <TableRow
                key={client.clientId}
                columns={CLIENT_COLUMNS}
                last={index === census.clients.length - 1}
                testID={`admin-client-${client.clientId}`}
                cells={[
                  <Text key="name" variant="rowTitle" numberOfLines={1}>
                    {client.clientName}
                  </Text>,
                  <Text key="active" style={styles.strongNum}>
                    {formatCount(client.active)}
                  </Text>,
                  <Text key="contexts" variant="meta" style={styles.num}>
                    {formatCount(client.contexts)}
                  </Text>,
                  <Text key="accounts" variant="meta" style={styles.num}>
                    {formatCount(client.accounts)}
                  </Text>,
                  <Text key="revoked" variant="meta" style={styles.num}>
                    {client.revoked > 0 ? formatCount(client.revoked) : "—"}
                  </Text>,
                  <Text key="used" variant="meta">
                    {formatLastUsed(client.lastUsedAt)}
                  </Text>,
                ]}
              />
            ))}
          </View>
        )}
      </Panel>

      <Panel flush title="Other capture sources" testID="admin-sources">
        <View style={compact ? null : styles.grid}>
          {[
            {
              key: "google",
              label: "Google accounts",
              sub: `${formatCount(src.gmail)} mail · ${formatCount(src.calendar)} calendar · ${formatCount(src.chat)} chat`,
              value: src.googleAccounts,
            },
            {
              key: "mail",
              label: "Mail capture",
              sub: `${formatCount(src.mailAllowlisted)} allowlisted · ${formatCount(src.mailOpen)} open to anyone`,
              value: src.mailAllowlisted + src.mailOpen,
              openInbox: src.mailOpen > 0,
            },
            {
              key: "dropbox",
              label: "Dropbox as storage",
              sub: "a folder rather than a bucket",
              value: src.dropbox,
            },
            {
              key: "obsidian",
              label: "Obsidian plugins",
              sub: "contexts with a live plugin grant",
              value: src.obsidian,
            },
          ].map((entry, index) => (
            <View
              key={entry.key}
              style={
                compact
                  ? null
                  : [styles.gridCell, index % 2 === 0 && styles.gridLeft, index >= 2 && styles.gridRuled]
              }
            >
              <ListRow
                first={compact ? index === 0 : true}
                title={
                  <View style={styles.sourceTitle}>
                    <Text variant="rowTitle">{entry.label}</Text>
                    {entry.openInbox ? <Pill tone="warn">open inbox</Pill> : null}
                  </View>
                }
                sub={entry.sub}
                trailing={<RowValue>{formatCount(entry.value)}</RowValue>}
                testID={`admin-source-${entry.key}`}
              />
            </View>
          ))}
        </View>
      </Panel>
    </View>
  );
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** A figure inside a card. Not a card inside a card, which is what it was. */
function Mini({
  label,
  value,
  caption,
  ok = false,
  testID,
}: {
  label: string;
  value: string;
  caption: string;
  ok?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.mini} testID={testID}>
      <Text variant="meta">{label}</Text>
      <Text style={[styles.miniValue, ok && styles.ok]}>{value}</Text>
      <Text variant="meta">{caption}</Text>
    </View>
  );
}

function EstateSkeleton() {
  const styles = useThemedStyles(makeStyles);
  const panel = (
    <Card style={styles.fill}>
      <Skeleton width={120} height={14} />
      <Skeleton width="100%" height={8} style={styles.skGap} />
      <Skeleton width="100%" height={120} style={styles.skGap} />
    </Card>
  );
  return (
    <View style={styles.section} aria-busy testID="admin-loading">
      <TwoUp>
        {panel}
        {panel}
      </TwoUp>
      {panel}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    fill: { flexGrow: 1 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.x4 },
    providers: { marginTop: 14 },
    num: { fontVariant: ["tabular-nums"] },
    strongNum: {
      fontSize: pointerType.ui,
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    strong: { color: colors.text, fontWeight: "600" },
    minis: { flexDirection: "row", gap: space.x3 },
    mini: { flex: 1, minWidth: 0 },
    miniValue: {
      fontSize: pointerType.h2,
      lineHeight: leading(pointerType.h2, 1.3),
      fontWeight: "600",
      letterSpacing: -0.7,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    ok: { color: colors.ok },
    gapTop: { marginTop: 18 },
    unresolved: { marginTop: 10 },
    grid: { flexDirection: "row", flexWrap: "wrap" },
    gridCell: { width: "50%" },
    gridLeft: { borderRightWidth: 1, borderRightColor: colors.line },
    gridRuled: { borderTopWidth: 1, borderTopColor: colors.line },
    sourceTitle: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    skGap: { marginTop: 18 },
  });
