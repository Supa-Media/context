/**
 * Who is here, newest first.
 *
 * **A roster is the honest dashboard at this size**, and it is control-plane
 * metadata only — an address, when they arrived, how many contexts, whether
 * storage verified, how many clients, what they pay. Nothing about what they
 * wrote: `functions/admin.ts` carries the standing rule, and this card is the
 * thing most likely to tempt somebody to break it. Do not add a column that
 * names a note, a folder, or a search.
 *
 * It used to be four filled pills per person, thirty-two chips in green,
 * amber and grey, which made the one thing worth seeing — who is stuck — the
 * hardest thing to see. Now a cell is a number, and colour is spent only on
 * what is missing: a warn dot at zero, a dashed ring for storage not yet
 * attempted, a pill only for a plan that is not Free.
 */

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
import { storageState, type RosterRow } from "./growth";
import { formatCount, formatLastUsed, planLabel, planTone, relativeTime } from "./report";

const COLUMNS: readonly Column[] = [
  { label: "Account", flex: 2.4 },
  { label: "Joined", flex: 1 },
  { label: "Last seen", flex: 1 },
  { label: "Contexts", flex: 0.9, align: "right" },
  { label: "Storage", flex: 1.2 },
  { label: "Clients", flex: 0.8, align: "right" },
  { label: "Plan", flex: 0.9 },
];

export function RosterCard({
  roster,
  total,
}: {
  roster: readonly RosterRow[];
  /** Every account, as `formatTotal` spells it, for "8 of 14". */
  total: string;
}) {
  const compact = useCompact();

  if (roster.length === 0) {
    return (
      <Panel title="Accounts" testID="admin-roster">
        <EmptyNote title="Nobody has signed up yet" body="New accounts appear here, newest first." />
      </Panel>
    );
  }

  return (
    <Panel
      flush
      title="Accounts"
      meta={`newest first · ${formatCount(roster.length)} of ${total}`}
      testID="admin-roster"
    >
      {compact ? (
        roster.map((row, index) => (
          <ListRow
            key={`${row.email ?? "anon"}-${row.joinedAt}`}
            first={index === 0}
            title={row.email ?? "no address"}
            sub={`joined ${relativeTime(row.joinedAt)} · seen ${formatLastUsed(row.lastSeenAt)}`}
            extra={<PhoneFacts row={row} />}
            trailing={<Plan plan={row.plan} />}
          />
        ))
      ) : (
        <View>
          <TableHead columns={COLUMNS} />
          {roster.map((row, index) => (
            <TableRow
              key={`${row.email ?? "anon"}-${row.joinedAt}`}
              columns={COLUMNS}
              last={index === roster.length - 1}
              cells={[
                <Text key="who" variant="rowTitle" numberOfLines={1}>
                  {row.email ?? "no address"}
                </Text>,
                <Text key="joined" variant="meta">
                  {relativeTime(row.joinedAt)}
                </Text>,
                <Text key="seen" variant="meta">
                  {formatLastUsed(row.lastSeenAt)}
                </Text>,
                <Count key="contexts" value={row.contexts} />,
                <Storage key="storage" row={row} />,
                <Count key="clients" value={row.clients} />,
                <Plan key="plan" plan={row.plan} />,
              ]}
            />
          ))}
        </View>
      )}
    </Panel>
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

/**
 * Storage has three states and the middle one is the one the old page drew
 * dashed: the account owns a context but no bucket under it has verified.
 * "Not yet" must not read as a failure, so it is a dashed ring rather than a
 * warn dot.
 */
function Storage({ row }: { row: RosterRow }) {
  const styles = useThemedStyles(makeStyles);
  const state = storageState(row);
  if (state === "connected") {
    return (
      <View style={styles.cell}>
        <Dot tone="ok" />
        <Text style={styles.num}>{formatCount(row.connectedStorage)}</Text>
      </View>
    );
  }
  if (state === "pending") {
    return (
      <View style={styles.cell}>
        <View style={styles.ring} aria-hidden />
        <Text style={[styles.num, styles.warn]}>none yet</Text>
      </View>
    );
  }
  return <Count value={0} />;
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

/** A phone row's third line: the three counts, what is missing in warn. */
function PhoneFacts({ row }: { row: RosterRow }) {
  const styles = useThemedStyles(makeStyles);
  const state = storageState(row);
  const parts: { text: string; missing: boolean }[] = [
    row.contexts > 0
      ? { text: `${formatCount(row.contexts)} ${row.contexts === 1 ? "context" : "contexts"}`, missing: false }
      : { text: "no context", missing: true },
    state === "connected"
      ? { text: `${formatCount(row.connectedStorage)} storage`, missing: false }
      : { text: state === "pending" ? "storage not yet" : "no storage", missing: true },
    row.clients > 0
      ? { text: `${formatCount(row.clients)} ${row.clients === 1 ? "client" : "clients"}`, missing: false }
      : { text: "no client", missing: true },
  ];
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
    num: {
      fontSize: pointerType.ui,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    warn: { color: colors.warnText },
    ring: {
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
    },
    plain: { fontSize: pointerType.meta, color: colors.muted },
    phoneFacts: {
      marginTop: 2,
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.5),
      color: colors.muted,
    },
  });
