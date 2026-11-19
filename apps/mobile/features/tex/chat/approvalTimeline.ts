import type { Approval } from "../../approvals/gateway";
import type { DecidedApproval } from "../../approvals/useApprovals";
import type { ChatLine } from "./appChatGateway";

/** Where an approval card stands: waiting, being sent, or settled one way. */
export type ApprovalCardState = "pending" | "busy" | "approved" | "declined" | "gone";

/** One thing in the Tex log: a chat line, or an approval card asked at that point. */
export type TimelineEntry =
  | { kind: "line"; line: ChatLine }
  | { kind: "approval"; approval: Approval; state: ApprovalCardState; note: string | null };

/** What `chatTimeline` needs from `useApprovals`. Named so the tests can build it. */
export interface TimelineApprovals {
  items: readonly Approval[];
  decided: readonly DecidedApproval[];
  busyId: string | null;
}

/**
 * The Tex log in order: the chat lines as given, with each approval card placed
 * where it was asked.
 *
 * A card goes before the first line whose time is later than its `createdAt`,
 * so a line sent at the same moment comes before the card, which is the order a
 * person would have read them in. Cards keep their own order by `createdAt`.
 */
export function chatTimeline(
  lines: readonly ChatLine[],
  approvals: TimelineApprovals | null | undefined,
): TimelineEntry[] {
  const cards: Array<Extract<TimelineEntry, { kind: "approval" }>> = [];
  if (approvals !== null && approvals !== undefined) {
    for (const approval of approvals.items) {
      const state: ApprovalCardState = approval.id === approvals.busyId ? "busy" : "pending";
      cards.push({ kind: "approval", approval, state, note: null });
    }
    for (const decided of approvals.decided) {
      const state: ApprovalCardState =
        decided.outcome === "approved" ? "approved" : decided.outcome === "declined" ? "declined" : "gone";
      cards.push({ kind: "approval", approval: decided.approval, state, note: decided.note });
    }
  }
  cards.sort((a, b) => a.approval.createdAt - b.approval.createdAt);

  // Each card's slot is the index of the first line later than it, or the end.
  const slots = new Map<number, TimelineEntry[]>();
  for (const card of cards) {
    const at = lines.findIndex((line) => line.at > card.approval.createdAt);
    const slot = at === -1 ? lines.length : at;
    const group = slots.get(slot) ?? [];
    group.push(card);
    slots.set(slot, group);
  }

  const out: TimelineEntry[] = [];
  lines.forEach((line, index) => {
    out.push(...(slots.get(index) ?? []));
    out.push({ kind: "line", line });
  });
  out.push(...(slots.get(lines.length) ?? []));
  return out;
}
