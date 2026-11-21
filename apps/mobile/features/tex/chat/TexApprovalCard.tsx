import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { askedLine, clientLine, expiryLine } from "../../approvals/copy";
import type { Approval, DecisionAction } from "../../approvals/gateway";
import type { ApprovalCardState } from "./approvalTimeline";
import { WAITING_HEAD } from "./TexAskCard";
import { AskButton, AskFace, SendingLine, type FaceField, type FaceHead } from "./TexAskFace";

/**
 * A held call from an AI client, drawn as a card in the Tex log on Tex's side, on the same face as Tex's own asks.
 *
 * Draws what it is given and decides nothing: a press goes back up through `onDecide`, and the hook owns whether it
 * took. The tool's name and its raw arguments are not drawn. A `send_email` call is drawn as its fields and its body;
 * any other call as its summary and its detail. A vault payment's card and a vault key's first use run nothing, so
 * they say so and carry no buttons beyond the decision.
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
  const email = emailOf(approval);
  const sendLabel = email !== null ? "Send" : "Go ahead";

  const head = headOf(approval.id, state);
  const fields: FaceField[] | undefined = email !== null ? emailFields(email) : undefined;

  const actions = waiting ? (
    busy ? (
      <SendingLine testID={`tex-approval-busy-${approval.id}`} />
    ) : (
      <>
        {vaultUse ? (
          <AskButton
            label="Yes, from now on"
            variant="ghost"
            onPress={() => onDecide(approval.id, "approve_always")}
            accessibilityLabel={`Yes, from now on: ${approval.summary}`}
            testID={`tex-approval-always-${approval.id}`}
          />
        ) : null}
        <AskButton
          label={sendLabel}
          variant="primary"
          onPress={() => onDecide(approval.id, "approve")}
          accessibilityLabel={`Approve: ${approval.summary}`}
          testID={`tex-approval-approve-${approval.id}`}
        />
        <AskButton
          label="Not now"
          variant="ghost"
          onPress={() => onDecide(approval.id, "deny")}
          accessibilityLabel={`Decline: ${approval.summary}`}
          testID={`tex-approval-decline-${approval.id}`}
        />
      </>
    )
  ) : null;

  const footer = (
    <View style={styles.footer}>
      {waiting && approval.kind === "vault_pay" ? (
        <Text variant="foot" style={styles.muted} testID={`tex-approval-pay-${approval.id}`}>
          Allowing fills the card once, on this site only, in the next 10 minutes. Tex tells you the total before it pays.
        </Text>
      ) : null}
      {approval.audience !== null ? (
        <Text variant="foot" style={styles.muted}>
          Audience: {approval.audience}
        </Text>
      ) : null}
      <Text variant="foot" style={styles.muted}>
        {[clientLine(approval.client), askedLine(approval.createdAt, now), ...(waiting ? [expiryLine(approval.expiresAt, now)] : [])].join(" · ")}
      </Text>
      {!waiting && note !== null ? (
        <Text variant="foot" style={styles.muted} testID={`tex-approval-note-${approval.id}`}>
          {note}
        </Text>
      ) : null}
    </View>
  );

  return (
    <AskFace
      testID={`tex-approval-${approval.id}`}
      head={head}
      fields={fields}
      title={email === null ? approval.summary : undefined}
      body={
        email !== null
          ? { value: email.body, testID: `tex-approval-body-${approval.id}`, label: "Email text" }
          : approval.detail !== undefined
            ? { value: approval.detail, testID: `tex-approval-body-${approval.id}`, label: "Details" }
            : undefined
      }
      actions={actions}
      footer={footer}
    />
  );
}

/** The head for each state. Settled cards keep their words: Approved, Declined, or No longer waiting. */
function headOf(id: string, state: ApprovalCardState): FaceHead {
  const testID = `tex-approval-state-${id}`;
  if (state === "pending" || state === "busy") return { tone: "warn", icon: "lock", text: WAITING_HEAD };
  if (state === "approved") return { tone: "ok", icon: "check", text: "Approved", testID };
  if (state === "declined") return { tone: "muted", icon: null, text: "Declined", testID };
  return { tone: "muted", icon: null, text: "No longer waiting", testID };
}

/** The email a `send_email` call would send, read from its arguments; `null` for any other call or a call that is not one plain email. */
interface EmailShape {
  from: string | null;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

function emailOf(approval: Approval): EmailShape | null {
  if (approval.tool !== "send_email") return null;
  const args = objectOf(approval.args);
  if (args === null) return null;
  // A forward or an attachment is not one plain email: it keeps the summary and the detail.
  if (args.forward || (Array.isArray(args.attach) ? args.attach.length > 0 : Boolean(args.attach))) return null;
  const to = listOf(args.to);
  if (to === null || typeof args.subject !== "string" || typeof args.body !== "string") return null;
  return {
    from: typeof args.from === "string" && args.from.length > 0 ? args.from : null,
    to,
    cc: listOf(args.cc) ?? "",
    subject: args.subject,
    body: args.body,
  };
}

function emailFields(email: EmailShape): FaceField[] {
  const rows: FaceField[] = [];
  if (email.from !== null) rows.push({ label: "From", value: email.from });
  rows.push({ label: "To", value: email.to });
  if (email.cc.length > 0) rows.push({ label: "Cc", value: email.cc });
  rows.push({ label: "Subject", value: email.subject });
  return rows;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A list of addresses as one comma-joined line; a single address as it is; anything else `null`. */
function listOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(", ");
  return null;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    footer: { gap: space.x1 },
    muted: { color: colors.muted },
  });
