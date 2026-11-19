import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { argsText, askedLine, clientLine, expiryLine } from "../../approvals/copy";
import type { Approval, DecisionAction } from "../../approvals/gateway";
import type { ApprovalCardState } from "./approvalTimeline";

/** The heading over a card that is waiting for the person's yes. */
export const APPROVAL_HEADING = "Waiting for your OK";

/**
 * A held call from an AI client, drawn as a card in the Tex log on Tex's side.
 *
 * Draws what it is given and decides nothing: a press goes back up through
 * `onDecide`, and the hook owns whether it took. Text is drawn as words only.
 * A vault payment's card and a vault key's first use run nothing, so their
 * arguments are not drawn: the tool and its arguments are for a call that runs.
 */
export function TexApprovalCard({
  approval,
  state,
  note,
  now,
  onDecide,
}: {
  approval: Approval;
  state: ApprovalCardState;
  note: string | null;
  now: number;
  onDecide: (id: string, action: DecisionAction) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const waiting = state === "pending" || state === "busy";
  const busy = state === "busy";
  const vaultUse = approval.kind === "vault_use";
  const nothingRuns = vaultUse || approval.kind === "vault_pay";

  return (
    <View style={styles.card} testID={`tex-approval-${approval.id}`}>
      {waiting ? (
        <Text variant="meta" style={styles.heading}>
          {APPROVAL_HEADING}
        </Text>
      ) : null}
      <Text variant="body" style={styles.summary}>
        {approval.summary}
      </Text>
      <Text variant="foot" style={styles.muted}>
        {[clientLine(approval.client), askedLine(approval.createdAt, now), ...(waiting ? [expiryLine(approval.expiresAt, now)] : [])].join(" · ")}
      </Text>
      {approval.kind === "vault_pay" && waiting ? (
        <Text variant="foot" style={styles.muted} testID={`tex-approval-pay-${approval.id}`}>
          Allowing fills the card once, on this site only, in the next 10 minutes. Tex tells you the total before it pays.
        </Text>
      ) : null}
      {approval.audience !== null ? (
        <Text variant="foot" style={styles.muted}>
          Audience: {approval.audience}
        </Text>
      ) : null}
      {approval.detail !== undefined ? (
        <Text variant="body" style={styles.detail} selectable>
          {approval.detail}
        </Text>
      ) : null}
      {nothingRuns ? null : (
        <View style={styles.args}>
          <Text variant="mono" style={styles.tool}>
            {approval.tool}
          </Text>
          <Text variant="mono" selectable>
            {argsText(approval.args)}
          </Text>
        </View>
      )}

      {waiting ? (
        <View style={styles.actions}>
          {vaultUse ? (
            <Button
              label="Yes, from now on"
              variant="decision"
              disabled={busy}
              onPress={() => onDecide(approval.id, "approve_always")}
              accessibilityLabel={`Yes, from now on: ${approval.summary}`}
              testID={`tex-approval-always-${approval.id}`}
            />
          ) : null}
          <Button
            label="Approve"
            variant="accent"
            disabled={busy}
            onPress={() => onDecide(approval.id, "approve")}
            accessibilityLabel={`Approve: ${approval.summary}`}
            testID={`tex-approval-approve-${approval.id}`}
          />
          <Button
            label="Decline"
            variant="decision"
            disabled={busy}
            onPress={() => onDecide(approval.id, "deny")}
            accessibilityLabel={`Decline: ${approval.summary}`}
            testID={`tex-approval-decline-${approval.id}`}
          />
        </View>
      ) : null}

      {busy ? (
        <Text variant="meta" style={styles.muted} testID={`tex-approval-busy-${approval.id}`}>
          Sending…
        </Text>
      ) : null}
      {waiting ? null : (
        <View style={styles.status}>
          <Text variant="meta" style={styles.statusText} testID={`tex-approval-state-${approval.id}`}>
            {settledWords(state)}
          </Text>
          {note !== null ? (
            <Text variant="foot" style={styles.muted} testID={`tex-approval-note-${approval.id}`}>
              {note}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** What a settled card says about itself, in the person's words. */
function settledWords(state: ApprovalCardState): string {
  if (state === "approved") return "Approved";
  if (state === "declined") return "Declined";
  return "No longer waiting";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "flex-start",
      maxWidth: "85%",
      gap: space.x2,
      padding: space.x3,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    heading: { color: colors.accentText },
    summary: { color: colors.text },
    detail: { color: colors.text },
    muted: { color: colors.muted },
    tool: { color: colors.text },
    args: { gap: space.x1, padding: space.x2, borderRadius: 6, backgroundColor: colors.chrome },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    status: { gap: space.x1 },
    statusText: { color: colors.text2 },
  });
