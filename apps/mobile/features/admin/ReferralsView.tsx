/**
 * The Waitlist tab's "Invited by friends" view: every referral, who sent it,
 * what became of it, and the two things staff can do about one — stop an
 * unused invite, and trace where it went.
 *
 * Revoke asks in place rather than in a dialog: the question is about the row
 * it sits under, and the answer ("the link stops working, nobody is emailed")
 * is what somebody needs to read before pressing, not after. The switch in
 * the header pauses *new* invites; the ones already sent keep working, which
 * its line says so nobody reads "off" as "every link just died".
 */

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Notice, Pill, Text, leading, radii, space, useThemedStyles, type Colors } from "../design";
import { Switch } from "../design/components/Switch";
import { TextLink } from "../design/components/TextLink";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, useCompact, usePanelPad } from "./AdminKit";
import { TableRow, type Column } from "./AdminTable";
import { ReferralTrace } from "./ReferralTrace";
import { Segments } from "./Segments";
import { messageFor } from "./SecretDialogs";
import {
  REFERRAL_FILTERS,
  byLine,
  filterCount,
  filterReferrals,
  revokeQuestion,
  revokedSentence,
  statusPill,
  type ReferralCounts,
  type ReferralFilter,
  type ReferralRow,
} from "./referrals";
import { shortDate } from "./waitlist";

export interface ReferralList {
  rows: ReferralRow[];
  more: boolean;
  counts: ReferralCounts;
  invitesOff: boolean;
}

interface Outcome {
  tone: "ok" | "warn";
  sentence: string;
}

export function ReferralsView({ list }: { list: ReferralList | undefined }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [filter, setFilter] = useState<ReferralFilter>("all");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tracing, setTracing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const revoke = useMutation(api.functions.admin.revokeReferral);
  const setInvitesOff = useMutation(api.functions.admin.setInvitesOff);

  const rows = useMemo(() => filterReferrals(list?.rows ?? [], filter), [list, filter]);

  async function guarded(work: () => Promise<string>) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome({ tone: "ok", sentence: await work() });
    } catch (caught) {
      setOutcome({ tone: "warn", sentence: messageFor(caught, "That did not work. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  const onRevoke = (row: ReferralRow) =>
    guarded(async () => {
      const result = await revoke({ inviteId: row.id as Id<"referralInvites"> });
      setConfirming(null);
      return revokedSentence(result.changed, row.email);
    });

  const onSwitch = (canInvite: boolean) =>
    guarded(async () => {
      const result = await setInvitesOff({ off: !canInvite });
      return result.invitesOff
        ? "New invites are paused. Links already sent still work."
        : "Friends can invite again.";
    });

  const actions: RowActions = {
    busy,
    confirming,
    tracing,
    onConfirm: (id) => setConfirming((was) => (was === id ? null : id)),
    onTrace: (id) => setTracing((was) => (was === id ? null : id)),
    onRevoke,
  };

  return (
    <View style={styles.view}>
      <View style={[styles.head, compact && styles.headCompact]}>
        <Text variant="meta" style={styles.headText}>
          People who got an invite from a friend. Revoking an unused one stops its link.
        </Text>
        {list === undefined ? null : (
          <View style={styles.switchRow}>
            <Text variant="meta" style={styles.switchLabel}>
              Friends can invite
            </Text>
            <Switch
              label="Friends can invite"
              value={!list.invitesOff}
              onValueChange={onSwitch}
              disabled={busy}
              testID="admin-referrals-switch"
            />
          </View>
        )}
      </View>

      {list?.invitesOff ? (
        <Text variant="foot">New invites are paused. Links already sent still work.</Text>
      ) : null}

      {list === undefined ? null : (
        <Segments
          options={REFERRAL_FILTERS}
          value={filter}
          onChange={setFilter}
          counts={(key) => filterCount(list.counts, key)}
          label="Referrals"
          testID="admin-referrals-filter"
        />
      )}

      {outcome ? (
        <Notice tone={outcome.tone} testID="admin-referrals-outcome">
          <NoticeLine mark={outcome.tone === "ok" ? "✓" : "!"} tone={outcome.tone}>
            {outcome.sentence}
          </NoticeLine>
        </Notice>
      ) : null}

      {list === undefined ? (
        <Card>
          <Skeleton width={120} height={14} />
          <Skeleton width="100%" height={120} style={styles.skGap} />
        </Card>
      ) : (
        <Panel flush>
          {rows.length === 0 ? (
            <EmptyNote
              title="No referrals yet"
              body="People get 3 invites once they connect an AI. They'll show up here."
              testID="admin-referrals-empty"
            />
          ) : compact ? (
            rows.map((row, index) => <StackedRow key={row.id} row={row} first={index === 0} actions={actions} />)
          ) : (
            <WideTable rows={rows} actions={actions} />
          )}
        </Panel>
      )}

      {list?.more ? <Text variant="foot">Showing the newest {list.rows.length}.</Text> : null}
    </View>
  );
}

interface RowActions {
  busy: boolean;
  confirming: string | null;
  tracing: string | null;
  onConfirm: (id: string) => void;
  onTrace: (id: string) => void;
  onRevoke: (row: ReferralRow) => void;
}

const COLUMNS: Column[] = [
  { label: "Invited", flex: 2 },
  { label: "By", flex: 2 },
  { label: "Sent", width: 56 },
  { label: "Status", flex: 1.4 },
  { label: " ", width: 132, align: "right" },
];

function WideTable({ rows, actions }: { rows: readonly ReferralRow[]; actions: RowActions }) {
  const styles = useThemedStyles(makeStyles);
  const head = (label: string) => (
    <Text variant="eyebrow" numberOfLines={1}>
      {label}
    </Text>
  );
  return (
    <>
      <TableRow columns={COLUMNS} cells={[head("Invited"), head("By"), head("Sent"), head("Status"), null]} />
      {rows.map((row, index) => (
        <View key={row.id} style={index === 0 ? null : styles.ruled}>
          <TableRow
            columns={COLUMNS}
            last
            testID={`admin-referral-row-${row.id}`}
            cells={[
              <Text key="email" variant="rowTitle" numberOfLines={1} style={styles.email}>
                {row.email}
              </Text>,
              <Text key="by" variant="meta" numberOfLines={1}>
                {byLine(row)}
              </Text>,
              <Text key="sent" variant="meta" numberOfLines={1}>
                {shortDate(row.sentAt)}
              </Text>,
              <StatusPill key="status" row={row} />,
              <RowButtons key="actions" row={row} actions={actions} />,
            ]}
          />
          <RowExtras row={row} actions={actions} />
        </View>
      ))}
    </>
  );
}

function StackedRow({ row, first, actions }: { row: ReferralRow; first: boolean; actions: RowActions }) {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  return (
    <View style={[{ paddingHorizontal: pad.x }, styles.stacked, !first && styles.ruled]}>
      <View style={styles.stackedMain} testID={`admin-referral-row-${row.id}`}>
        <Text variant="rowTitle" style={styles.emailCompact}>
          {row.email}
        </Text>
        <Text variant="meta">
          {byLine(row)} · {shortDate(row.sentAt)}
        </Text>
        <View style={styles.stackedFoot}>
          <StatusPill row={row} />
          <RowButtons row={row} actions={actions} />
        </View>
      </View>
      <RowExtras row={row} actions={actions} inset={false} />
    </View>
  );
}

function StatusPill({ row }: { row: ReferralRow }) {
  const pill = statusPill(row.status, row.joinedHandle);
  return (
    <Pill tone={pill.tone} testID={`admin-referral-status-${row.id}`}>
      {pill.label}
    </Pill>
  );
}

function RowButtons({ row, actions }: { row: ReferralRow; actions: RowActions }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.buttons}>
      <TextLink
        label={actions.tracing === row.id ? "Close" : "Trace"}
        accessibilityLabel={`Trace the invite to ${row.email}`}
        onPress={() => actions.onTrace(row.id)}
        testID={`admin-referral-trace-${row.id}`}
      />
      {row.status === "pending" ? (
        <Button
          label="Revoke"
          variant="danger"
          accessibilityLabel={`Revoke the invite to ${row.email}`}
          disabled={actions.busy}
          onPress={() => actions.onConfirm(row.id)}
          testID={`admin-referral-revoke-${row.id}`}
        />
      ) : null}
    </View>
  );
}

/** The in-place confirm and the trace, under the row they belong to. */
function RowExtras({ row, actions, inset = true }: { row: ReferralRow; actions: RowActions; inset?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  const confirming = actions.confirming === row.id && row.status === "pending";
  const tracing = actions.tracing === row.id;
  if (!confirming && !tracing) return null;
  return (
    <View style={[styles.extras, inset && { paddingHorizontal: pad.x }]}>
      {confirming ? (
        <View style={styles.confirm} role="alert" testID={`admin-referral-confirm-${row.id}`}>
          <Text variant="check" style={styles.confirmText}>
            {revokeQuestion(row)}
          </Text>
          <View style={styles.buttons}>
            <Button
              label="Revoke"
              variant="dialogDanger"
              disabled={actions.busy}
              onPress={() => actions.onRevoke(row)}
              testID={`admin-referral-revoke-confirm-${row.id}`}
            />
            <Button label="Keep" variant="dialog" onPress={() => actions.onConfirm(row.id)} />
          </View>
        </View>
      ) : null}
      {tracing ? <ReferralTrace row={row} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    view: { gap: space.x4 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    headCompact: { flexDirection: "column", alignItems: "flex-start" },
    headText: { flexShrink: 1 },
    switchRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    switchLabel: { color: colors.text, fontWeight: "500" },
    email: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    emailCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4) },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    stacked: { paddingVertical: space.x3, gap: space.x2 },
    stackedMain: { gap: 4, minWidth: 0 },
    stackedFoot: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x2,
      marginTop: 2,
    },
    buttons: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    extras: { gap: space.x3, paddingBottom: space.x3 },
    confirm: {
      gap: space.x3,
      padding: space.x3,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.critBorder,
      backgroundColor: colors.critWash,
    },
    confirmText: { color: colors.text },
    skGap: { marginTop: 18 },
  });
