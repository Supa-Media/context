/**
 * Folding the audit trail's repeats into one row each.
 *
 * The console's own agent renews its grant on every load and every expiry,
 * and each renewal is a real audit event (`agent.session.renewed` in
 * `apps/convex/functions/agentGrant.ts`). Drawn one per row, a morning of
 * reloads was a wall of identical lines that pushed every actual change off
 * the screen. The events stay exactly as recorded; only the drawing folds.
 *
 * Only **back-to-back** rows fold. Grouping every renewal of the day into one
 * row, wherever it fell, would reorder the trail: an edit made between two
 * renewals would appear to happen after both. A trail that reads out of order
 * is not evidence, so a run ends at the first row that differs.
 *
 * Pure and React-free, like `advanced.ts`.
 */

import { relativeTime } from "../format";
import { auditDetailLine, type ConsoleAuditEvent } from "./advanced";

export interface AuditGroup {
  /** The newest event in the run. Its id keys the row and its fields draw it. */
  event: ConsoleAuditEvent;
  /** How many recorded events the row stands for. 1 for an ordinary row. */
  count: number;
  /** When the oldest event in the run happened. Equal to `event.at` when `count` is 1. */
  firstAt: number;
}

/**
 * Two rows fold only when a reader could not tell them apart except by time:
 * the same action, by the same identity, on the same paths, with the same
 * detail line. Any one of those differing is a different fact and keeps its
 * own row.
 */
function sameFact(a: ConsoleAuditEvent, b: ConsoleAuditEvent): boolean {
  return (
    a.action === b.action &&
    a.actorUserId === b.actorUserId &&
    a.actorClientId === b.actorClientId &&
    a.actorEmail === b.actorEmail &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, i) => path === b.paths[i]) &&
    auditDetailLine(a) === auditDetailLine(b)
  );
}

/** Newest-first events in, newest-first rows out, with back-to-back repeats folded. */
export function groupAuditEvents(events: readonly ConsoleAuditEvent[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last !== undefined && sameFact(last.event, event)) {
      last.count += 1;
      last.firstAt = Math.min(last.firstAt, event.at);
    } else {
      groups.push({ event, count: 1, firstAt: event.at });
    }
  }
  return groups;
}

/**
 * The row's "when": one time for a single event, and for a folded run how
 * many there were and the span they cover, newest first like the trail.
 */
export function auditWhenLabel(group: AuditGroup, now: number): string {
  const latest = relativeTime(group.event.at, now);
  if (group.count === 1) return latest;
  const first = relativeTime(group.firstAt, now);
  if (first === latest) return `${group.count} times · ${latest}`;
  return `${group.count} times · ${first} to ${latest}`;
}
