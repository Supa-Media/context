/**
 * When each auto-organize surface is drawn, decided outside a component.
 *
 * The rule under all of them: suggestions are the owner's (v1), on a paying
 * workspace, with it switched on. A member, an editor, a free workspace and
 * one that switched it off never see a suggestion, a count or an offer — and
 * each surface asks the same functions here rather than re-deriving it.
 */

import { ORGANIZER_ACTOR } from "./copy";
import type { OrganizerStatus, SweepWhy } from "./types";

export type OrganizerState =
  | { kind: "loading" }
  /** No backend, a query that threw, or not a member: draw nothing, claim nothing. */
  | { kind: "unavailable" }
  | { kind: "ready"; status: OrganizerStatus };

/** What `useQueries` handed back for `organizer.status`, read once. */
export function organizerState(raw: unknown): OrganizerState {
  if (raw === undefined) return { kind: "loading" };
  if (raw === null || raw instanceof Error || typeof raw !== "object") return { kind: "unavailable" };
  return { kind: "ready", status: raw as OrganizerStatus };
}

/** Suggestions reach this person at all. */
function suggesting(status: OrganizerStatus | null): status is OrganizerStatus {
  return status !== null && status.available && status.isOwner && status.on;
}

/**
 * The What changed page is there at all. Switched off
 * on the server (`whatChanged`), there is no page, no sidebar row, no phone
 * line and no "Look over" press: nothing that opens a page that is not drawn.
 */
export function whatChangedPage(status: OrganizerStatus | null): status is OrganizerStatus {
  return suggesting(status) && status.whatChanged !== false;
}

/**
 * What changed's entry: the cards waiting (0 is still an entry, so the page
 * can be found before anything has arrived), or `null` where the person never
 * sees a suggestion at all.
 */
export function changesCount(status: OrganizerStatus | null): number | null {
  return whatChangedPage(status) ? (status.changes ?? 0) : null;
}

/** The phone's "2 things changed" on the workspace's own page, to the What changed page. */
export function phoneChangesCount(
  status: OrganizerStatus | null,
  where: { compact: boolean; atRoot: boolean },
): number | null {
  const count = changesCount(status);
  return where.compact && where.atRoot && count !== null && count > 0 ? count : null;
}

/** The one-time notice for people who were on Premium before this existed. */
export function existingNoticeVisible(status: OrganizerStatus | null): boolean {
  return status !== null && status.available && status.isOwner && status.noticeNeeded;
}

/** Settings › Premium's card: the owner's switches, a member's read-out, or none before Premium. */
export function settingsCard(status: OrganizerStatus | null): "owner" | "member" | null {
  if (status === null || !status.available) return null;
  return status.isOwner ? "owner" : "member";
}

/**
 * The first-run card at the top of Premium: reading, whenever a sweep is
 * running. It is live and it is true. A finished sweep leaves no card; what
 * it came up with is What changed's, and is counted there.
 */
export function sweepPhase(status: OrganizerStatus | null): "reading" | null {
  if (!suggesting(status) || status.sweep === null) return null;
  return status.sweep.state === "running" ? "reading" : null;
}

/** Ask for the first sweep on the payment return, once, and never over one already there. */
export function shouldStartSweep(
  status: OrganizerStatus | null,
  { returned, asked, now }: { returned: string | null; asked: boolean; now: number },
): boolean {
  if (asked || returned !== "done" || !suggesting(status)) return false;
  if (status.sweep !== null) return false;
  return status.startsAt === null || status.startsAt <= now;
}

/** A sweep that has said "running" this long has died (the server's `SWEEP_STALE_MS`). */
const SWEEP_STALE_MS = 30 * 60 * 1000;

/** Settings' answer to "is it sorting, and when did it last?" */
export type SortLine =
  | { kind: "running"; read: number; total: number }
  | { kind: "never" }
  | { kind: "done"; at: number }
  | { kind: "failed"; at: number; why?: SweepWhy };

/**
 * The owner's sort status, on the Auto-organize card. Only where suggestions
 * reach this person at all; a sweep still "running" past the server's stale
 * mark died, and reads as one that did not finish.
 */
export function sortLine(status: OrganizerStatus | null, now: number): SortLine | null {
  if (!suggesting(status)) return null;
  const sweep = status.sweep;
  if (sweep === null) return { kind: "never" };
  if (sweep.state === "running") {
    if (now - sweep.startedAt < SWEEP_STALE_MS) return { kind: "running", read: sweep.read, total: sweep.total };
    return { kind: "failed", at: sweep.startedAt };
  }
  const at = sweep.finishedAt ?? sweep.startedAt;
  if (sweep.state === "failed") return sweep.why ? { kind: "failed", at, why: sweep.why } : { kind: "failed", at };
  return { kind: "done", at };
}

/** A row in Activity that auto-organize wrote, whichever field carries its name. */
export function isOrganizerEntry(entry: { by: string | null; via: string | null }): boolean {
  return entry.by === ORGANIZER_ACTOR || entry.via === ORGANIZER_ACTOR;
}
