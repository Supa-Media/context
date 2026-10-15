/**
 * Who is here, most active first, and sortable by any column (Dev2, 2026-10-13).
 *
 * **A roster is the honest dashboard at this size**, and it is control-plane
 * metadata only — an address and phone, when they arrived, how many
 * workspaces, how many clients, what their AI use cost, what they pay, and
 * whether they may text Tex (the one column here that changes something:
 * `./TexAccess`, Dev2 2026-10-13).
 * Nothing about what they wrote: `functions/admin.ts` carries the standing
 * rule, and this card is the thing most likely to tempt somebody to break it.
 * Do not add a column that names a note, a folder, or a search.
 *
 * It used to be four filled pills per person, thirty-two chips in green,
 * amber and grey, which made the one thing worth seeing — who is stuck — the
 * hardest thing to see. Now a cell is a number, and colour is spent only on
 * what is missing: a warn dot at zero, a dashed ring for storage not yet
 * attempted, a pill only for a plan that is not Free.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Dot, Pill, Text, leading, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import {
  EmptyNote,
  Panel,
  useCompact,
} from "./AdminKit";
import {
  ListRow,
  TableHead,
  TableRow,
  type Column,
} from "./AdminTable";
import {
  AI_SPEND_HINT,
  aiSpendLabel,
  formatAiSpend,
  isFromWaitlist,
  type Audience,
  type NotSignedUpRow,
  type RosterEntry,
  type RosterRow,
} from "./growth";
import { formatCount, formatLastUsed, planLabel, planTone, relativeTime } from "./report";
import { DEFAULT_ROSTER_SORT, nextRosterSort, sortRoster, type RosterSort, type RosterSortKey } from "./rosterSort";
import { TexAccessProvider, TexFootnotes, TexSwitch, useTexListed, useTexMeta } from "./TexAccess";

/**
 * The AI column is cost, not content: one dollar figure per account, summed
 * over the workspaces it owns, for the census window — the attribution rule
 * lives in `apps/convex/functions/lib/jev/spend.ts`.
 */
function columnsFor(days: number): readonly Column[] {
  return [
    { label: "Account", flex: 2.4, sortKey: "account" },
    { label: "Joined", flex: 1, sortKey: "joined" },
    { label: "Last seen", flex: 1, sortKey: "seen" },
    { label: "Workspaces", flex: 1, align: "right", sortKey: "workspaces" },
    { label: "Clients", flex: 0.8, align: "right", sortKey: "clients" },
    { label: aiSpendLabel(days), flex: 0.9, align: "right", hint: AI_SPEND_HINT, sortKey: "ai" },
    { label: "Plan", flex: 0.9, sortKey: "plan" },
    { label: "Tex access", flex: 0.9, sortKey: "tex" },
  ];
}

type RosterProps = Parameters<typeof RosterTable>[0];

export function RosterCard(props: RosterProps) {
  return (
    <TexAccessProvider>
      <RosterTable {...props} />
    </TexAccessProvider>
  );
}

function RosterTable({
  entries: unsorted,
  total,
  days,
  audience = "everyone",
  notSignedUpTotal = 0,
}: {
  /** Accounts and let-in addresses with no account yet, newest first (`rosterEntries`). */
  entries: readonly RosterEntry[];
  /** Every account, as `formatTotal` spells it, for "8 of 14". */
  total: string;
  /** The census window the AI column covers. */
  days: number;
  audience?: Audience;
  /** Everybody let in without an account, which may be more than are listed. */
  notSignedUpTotal?: number;
}) {
  const compact = useCompact();
  const columns = columnsFor(days);
  const [sort, setSort] = useState<RosterSort>(DEFAULT_ROSTER_SORT);
  const entries = sortRoster(unsorted, sort, useTexListed());
  const accounts = entries.filter((entry) => entry.kind === "account").length;
  const texMeta = useTexMeta();
  const accountPhones = new Set(
    entries.flatMap((entry) => (entry.kind === "account" && entry.row.phone ? [entry.row.phone] : [])),
  );

  if (entries.length === 0) {
    return (
      <Panel title="Accounts" testID="admin-roster">
        {audience === "waitlist" ? (
          <EmptyNote
            title="Nobody let in from the waitlist yet"
            body="People you let in appear here, first as not signed up, then as accounts."
          />
        ) : (
          <EmptyNote title="Nobody has signed up yet" body="New accounts appear here, newest first." />
        )}
      </Panel>
    );
  }

  const counted =
    audience === "waitlist"
      ? `${formatCount(accounts)} signed up`
      : `${formatCount(accounts)} of ${total}`;
  const meta = [
    compact ? "most active first" : null,
    counted,
    ...(notSignedUpTotal > 0 ? [`${formatCount(notSignedUpTotal)} let in, not signed up`] : []),
    ...(texMeta ? [texMeta] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Panel flush title="Accounts" meta={meta} testID="admin-roster">
      {compact ? (
        entries.map((entry, index) =>
          entry.kind === "account" ? (
            <ListRow
              key={`${entry.row.email ?? "anon"}-${entry.row.joinedAt}`}
              first={index === 0}
              title={<Who email={entry.row.email} phone={entry.row.phone} waitlist={isFromWaitlist(entry.row)} />}
              sub={`joined ${relativeTime(entry.row.joinedAt)} · seen ${formatLastUsed(entry.row.lastSeenAt)}`}
              extra={<PhoneFacts row={entry.row} days={days} />}
              trailing={<CompactTrailing plan={entry.row.plan} phone={entry.row.phone ?? null} />}
            />
          ) : (
            <ListRow
              key={`pending-${entry.row.email}`}
              first={index === 0}
              title={<Who email={entry.row.email} waitlist />}
              sub={`let in ${relativeTime(entry.row.letInAt)} · not signed up yet`}
              trailing={<NotSignedUp />}
              testID="admin-roster-not-signed-up"
            />
          ),
        )
      ) : (
        <View>
          <TableHead
            columns={columns}
            sorted={sort}
            onSort={(key) => setSort((current) => nextRosterSort(current, key as RosterSortKey))}
          />
          {entries.map((entry, index) => {
            const last = index === entries.length - 1;
            if (entry.kind === "not-signed-up") {
              return (
                <PendingRow
                  key={`pending-${entry.row.email}`}
                  row={entry.row}
                  columns={columns}
                  last={last}
                />
              );
            }
            const row = entry.row;
            return (
              <TableRow
                key={`${row.email ?? "anon"}-${row.joinedAt}`}
                columns={columns}
                last={last}
                cells={[
                  <Who key="who" email={row.email} phone={row.phone} waitlist={isFromWaitlist(row)} />,
                  <Text key="joined" variant="meta">
                    {relativeTime(row.joinedAt)}
                  </Text>,
                  <Text key="seen" variant="meta">
                    {formatLastUsed(row.lastSeenAt)}
                  </Text>,
                  <Count key="workspaces" value={row.contexts} />,
                  <Count key="clients" value={row.clients} />,
                  <AiSpend key="ai" row={row} />,
                  <Plan key="plan" plan={row.plan} />,
                  <TexSwitch key="tex" phone={row.phone ?? null} />,
                ]}
              />
            );
          })}
        </View>
      )}
      <TexFootnotes accountPhones={accountPhones} />
    </Panel>
  );
}

/**
 * The address, a quiet "waitlist" after it for somebody let in from it, and
 * their phone under it.
 */
function Who({ email, phone, waitlist }: { email?: string; phone?: string | null; waitlist: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.whoColumn}>
      <View style={styles.who}>
        <Text variant="rowTitle" numberOfLines={1} style={styles.whoEmail}>
          {email ?? "no address"}
        </Text>
        {waitlist ? <Text style={styles.tag}>waitlist</Text> : null}
      </View>
      {phone ? (
        <Text style={styles.phone} numberOfLines={1}>
          {phone}
        </Text>
      ) : null}
    </View>
  );
}

/** A phone row's right edge: the plan, and the Tex access switch beside it. */
function CompactTrailing({ plan, phone }: { plan: string; phone: string | null }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cell}>
      <Plan plan={plan} />
      <TexSwitch phone={phone} />
    </View>
  );
}

/**
 * Let in, no account yet. Every account column is a dash rather than a warn
 * zero: there is nothing to be missing until they sign in.
 */
function PendingRow({
  row,
  columns,
  last,
}: {
  row: NotSignedUpRow;
  columns: readonly Column[];
  last: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const dash = (key: string) => (
    <Text key={key} style={styles.plain}>
      —
    </Text>
  );
  return (
    <TableRow
      columns={columns}
      last={last}
      testID="admin-roster-not-signed-up"
      cells={[
        <Who key="who" email={row.email} waitlist />,
        <Text key="joined" style={styles.plain}>
          not yet
        </Text>,
        <Text key="seen" variant="meta">
          let in {relativeTime(row.letInAt)}
        </Text>,
        dash("workspaces"),
        dash("clients"),
        dash("ai"),
        <NotSignedUp key="plan" />,
        dash("tex"),
      ]}
    />
  );
}

function NotSignedUp() {
  return (
    <Pill dashed tone="neutral">
      Not signed up
    </Pill>
  );
}

/** A number, or a warn dot and a zero — the one cell state worth colour. */
function Count({ value }: { value: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cell}>
      {value === 0 ? <Dot tone="warn" /> : null}
      <Text style={[styles.num, value === 0 && styles.warn]}>{formatCount(value)}</Text>
    </View>
  );
}

/** Dollars, or a muted dash for none: spending nothing is not a warning. */
function AiSpend({ row }: { row: RosterRow }) {
  const styles = useThemedStyles(makeStyles);
  const none = row.aiSpendMicroUsd <= 0 && !row.aiSpendPartial;
  return (
    <Text style={none ? styles.plain : styles.num}>
      {formatAiSpend(row.aiSpendMicroUsd, row.aiSpendPartial)}
    </Text>
  );
}

function Plan({ plan }: { plan: string }) {
  const styles = useThemedStyles(makeStyles);
  // Free is the default and the common case; a pill on every free row would
  // put back the wall of chips this card replaced.
  if (plan === "none") {
    return <Text style={styles.plain}>{planLabel(plan)}</Text>;
  }
  return <Pill tone={planTone(plan)}>{planLabel(plan)}</Pill>;
}

/**
 * A phone row's third line: the two counts, what is missing in warn, then
 * AI spend only where there is some — none is not something missing.
 */
function PhoneFacts({ row, days }: { row: RosterRow; days: number }) {
  const styles = useThemedStyles(makeStyles);
  const parts: { text: string; missing: boolean }[] = [
    row.contexts > 0
      ? { text: `${formatCount(row.contexts)} ${row.contexts === 1 ? "workspace" : "workspaces"}`, missing: false }
      : { text: "no workspace", missing: true },
    row.clients > 0
      ? { text: `${formatCount(row.clients)} ${row.clients === 1 ? "client" : "clients"}`, missing: false }
      : { text: "no client", missing: true },
  ];
  if (row.aiSpendMicroUsd > 0 || row.aiSpendPartial) {
    parts.push({
      text: `AI ${formatAiSpend(row.aiSpendMicroUsd, row.aiSpendPartial)} (${days}d)`,
      missing: false,
    });
  }
  return (
    <Text style={styles.phoneFacts}>
      {parts.map((part, index) => (
        <Text key={part.text} style={styles.phoneFacts}>
          {index > 0 ? " · " : ""}
          <Text style={[styles.phoneFacts, part.missing && styles.warn]}>{part.text}</Text>
        </Text>
      ))}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    cell: { flexDirection: "row", alignItems: "center", gap: 7 },
    whoColumn: { minWidth: 0 },
    who: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
    phone: { fontSize: pointerType.meta, color: colors.muted, fontVariant: ["tabular-nums"] },
    whoEmail: { flexShrink: 1 },
    tag: { fontSize: pointerType.meta, color: colors.muted },
    num: {
      fontSize: pointerType.ui,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    warn: { color: colors.warnText },
    plain: { fontSize: pointerType.meta, color: colors.muted },
    phoneFacts: {
      marginTop: 2,
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.5),
      color: colors.muted,
    },
  });
