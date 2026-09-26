/**
 * When each auto-organize surface is drawn, decided outside a component.
 *
 * The rule under all of them: suggestions are the owner's (v1), on a paying
 * workspace, with it switched on. A member, an editor, a free workspace and
 * one that switched it off never see a suggestion, a count or an offer — and
 * each surface asks the same functions here rather than re-deriving it.
 */

import {
  ORGANIZER_ACTOR,
  acceptedToast,
  offerToast,
  resolveFailed,
  reviewCopy,
} from "./copy";
import type {
  OrganizerDecision,
  OrganizerKind,
  OrganizerStatus,
  OrganizerSuggestion,
  ResolveResult,
} from "./types";

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

/** The explorer foot's "11 suggestions", or `null` for no line. */
export function footCount(status: OrganizerStatus | null): number | null {
  return suggesting(status) && status.pending > 0 ? status.pending : null;
}

/** The phone's "11 suggestions to look over", on the workspace's own page. */
export function phoneEntryCount(
  status: OrganizerStatus | null,
  where: { compact: boolean; atRoot: boolean },
): number | null {
  return where.compact && where.atRoot ? footCount(status) : null;
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
 * The first-run card at the top of Premium.
 *
 * Reading, whenever a sweep is running — it is live and it is true. What it
 * found, only on the payment return and until "Later": the card is the proof
 * the upgrade did something, and on an ordinary visit the explorer's foot line
 * already says what is waiting.
 */
export function sweepPhase(
  status: OrganizerStatus | null,
  { returned, later }: { returned: string | null; later: boolean },
): "reading" | "found" | null {
  if (!suggesting(status) || status.sweep === null) return null;
  if (status.sweep.state === "running") return "reading";
  if (status.sweep.state !== "done" || later || returned !== "done") return null;
  const { done, archive, file } = status.sweep.found;
  return done + archive + file > 0 ? "found" : null;
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

export interface SuggestionGroup {
  key: "projects" | "inbox";
  label: string;
  items: OrganizerSuggestion[];
}

/** "Projects · 4" then "Inbox · 7"; a group with nothing in it is not drawn. */
export function groupSuggestions(list: readonly OrganizerSuggestion[]): SuggestionGroup[] {
  const projects = list.filter((s) => s.kind !== "file");
  const inbox = list.filter((s) => s.kind === "file");
  const groups: SuggestionGroup[] = [];
  if (projects.length > 0) {
    groups.push({ key: "projects", label: `${reviewCopy.projects} · ${projects.length}`, items: projects });
  }
  if (inbox.length > 0) {
    groups.push({ key: "inbox", label: `${reviewCopy.inbox} · ${inbox.length}`, items: inbox });
  }
  return groups;
}

/** Up to two projects and an inbox note, then whatever else there is. */
export function previewSuggestions(list: readonly OrganizerSuggestion[], size = 3): OrganizerSuggestion[] {
  const projects = list.filter((s) => s.kind !== "file");
  const inbox = list.filter((s) => s.kind === "file");
  const picked = [...projects.slice(0, 2), ...inbox.slice(0, 1)];
  const rest = list.filter((s) => !picked.includes(s));
  const chosen = [...picked, ...rest].slice(0, size);
  // Projects first, as the review list groups them.
  return [...chosen.filter((s) => s.kind !== "file"), ...chosen.filter((s) => s.kind === "file")];
}

/** A row in Activity that auto-organize wrote, whichever field carries its name. */
export function isOrganizerEntry(entry: { by: string | null; via: string | null }): boolean {
  return entry.by === ORGANIZER_ACTOR || entry.via === ORGANIZER_ACTOR;
}

export interface OrganizerToast {
  message: string;
  tone: "neutral" | "warn";
  undo?: () => void;
  /** Present on the third accept in a row: offer "Yes, automatically". */
  offer?: OrganizerKind;
}

/**
 * What follows a press on ✓ or ✕.
 *
 * A dismiss says nothing: the row going is the answer. An accept says what
 * happened, with Undo where the server handed back a way to take it back. The
 * third accept of a kind in a row asks the offer question instead — and keeps
 * the Undo, because it is still the toast for that accept.
 */
export function resolveToast(
  suggestion: OrganizerSuggestion,
  decision: OrganizerDecision,
  result: ResolveResult,
  { undo }: { undo: () => void },
): OrganizerToast | null {
  if (!result.applied) return { message: resolveFailed, tone: "warn" };
  if (decision === "dismiss") return null;
  const back = result.undo === null || result.undo === undefined ? {} : { undo };
  if (result.offer !== null) {
    return { message: offerToast(result.offer), tone: "neutral", offer: result.offer, ...back };
  }
  return { message: acceptedToast(suggestion), tone: "neutral", ...back };
}
