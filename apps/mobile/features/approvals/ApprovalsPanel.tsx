import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Notice } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { useTick } from "../meetings/useMeetings";
import { argsText, askedLine, clientLine, expiryLine } from "./copy";
import type { Approval } from "./gateway";
import type { ApprovalsView } from "./useApprovals";

/**
 * What the egress gate is holding for this person, and their yes or no.
 *
 * Draws what `useApprovals` says and decides nothing itself. Every row shows
 * what would run before it offers a choice: the summary the gateway wrote, who
 * asked, when, and how long the answer is good for, with the arguments one
 * press away and read-only. Approve and Deny are the same shape, deliberately
 * — the design system's `decision` pair — so refusing is never the quieter
 * control.
 */

/** The line above the list, so a person knows what a row is asking. */
export const APPROVALS_INTRO =
  "An AI client asked to do something that would let more people see it. Nothing runs until you say yes.";

export const APPROVALS_EMPTY = "Nothing is waiting for your OK.";

export function ApprovalsPanel({ view }: { view: ApprovalsView }) {
  const styles = useThemedStyles(makeStyles);
  // Ticks while something is waiting, so "expires in N min" does not go stale on a panel left open.
  const tick = useTick(view.items.length > 0, 30_000);
  const now = tick === 0 ? Date.now() : tick;
  const busy = view.busyId !== null;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.body} testID="approvals-panel">
      <View style={styles.head}>
        <Text variant="foot" style={styles.intro}>
          {APPROVALS_INTRO}
        </Text>
        <Button
          label="Refresh"
          variant="mini"
          disabled={view.loading}
          onPress={view.refresh}
          testID="approvals-refresh"
        />
      </View>

      {view.notice !== null ? (
        <Notice tone={view.notice.tone} testID="approvals-notice">
          <Text variant="body">{view.notice.text}</Text>
        </Notice>
      ) : null}

      {view.phase === "failed" && view.error !== null ? (
        <Notice tone="warn" testID="approvals-error">
          <Text variant="body">{view.error}</Text>
        </Notice>
      ) : null}

      {view.phase === "idle" ? (
        <Text variant="foot" style={styles.quiet} testID="approvals-checking">
          Checking what is waiting…
        </Text>
      ) : null}

      {view.phase === "listed" && view.items.length === 0 ? (
        <Text variant="body" style={styles.quiet} testID="approvals-empty">
          {APPROVALS_EMPTY}
        </Text>
      ) : null}

      {view.items.map((approval) => (
        <ApprovalRow
          key={approval.id}
          approval={approval}
          now={now}
          busy={view.busyId === approval.id}
          disabled={busy}
          onApprove={() => view.decide(approval.id, "approve")}
          onDeny={() => view.decide(approval.id, "deny")}
        />
      ))}
    </ScrollView>
  );
}

function ApprovalRow({
  approval,
  now,
  busy,
  disabled,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  now: number;
  busy: boolean;
  disabled: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  return (
    <Card style={styles.card} testID={`approval-${approval.id}`}>
      <Text variant="rowTitle" style={styles.summary}>
        {approval.summary}
      </Text>
      <Text variant="foot" style={styles.meta}>
        {[clientLine(approval.client), askedLine(approval.createdAt, now), expiryLine(approval.expiresAt, now)].join(
          " · ",
        )}
      </Text>

      <Pressable
        role="button"
        accessibilityLabel={open ? "Hide what would run" : "Show what would run"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        testID={`approval-toggle-${approval.id}`}
      >
        <Text variant="rowSub" style={styles.toggle}>
          {open ? "Hide what would run" : "Show what would run"}
        </Text>
      </Pressable>

      {open ? (
        <View style={styles.detail} testID={`approval-detail-${approval.id}`}>
          <Text variant="mono" style={styles.tool}>
            {approval.tool}
          </Text>
          <ScrollView style={styles.argsBox} nestedScrollEnabled>
            <Text variant="mono" selectable>
              {argsText(approval.args)}
            </Text>
          </ScrollView>
          {approval.audience !== null ? (
            <Text variant="foot" style={styles.meta}>
              Audience: {approval.audience}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Approve"
          variant="decision"
          disabled={disabled}
          onPress={onApprove}
          accessibilityLabel={busy ? "Approving" : `Approve: ${approval.summary}`}
          testID={`approve-${approval.id}`}
        />
        <Button
          label="Deny"
          variant="decision"
          disabled={disabled}
          onPress={onDeny}
          accessibilityLabel={`Deny: ${approval.summary}`}
          testID={`deny-${approval.id}`}
        />
      </View>
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroll: { flex: 1, minHeight: 0 },
    body: { padding: space.x4, gap: space.x3 },
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x2 },
    intro: { color: colors.muted, flex: 1 },
    quiet: { color: colors.muted },
    card: { gap: space.x2 },
    summary: { color: colors.text },
    meta: { color: colors.muted },
    toggle: { color: colors.accent },
    detail: { gap: space.x2 },
    tool: { color: colors.text },
    argsBox: { maxHeight: 160, borderRadius: 6, backgroundColor: colors.chrome, padding: space.x2 },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap" },
  });
