/**
 * The "Invited by friends" view's words and small arithmetic, and the
 * community links' — kept apart from the screens so a sentence somebody reads
 * after a press is one place to change, and so all of it is testable without
 * a renderer.
 *
 * A referral is one person handing one of their invites to an email address.
 * It is not a workspace member sharing a workspace; that is a different
 * record and is not listed here.
 */

import type { PillTone } from "../design";
import { people, shortDate } from "./waitlist";

export type ReferralStatus = "pending" | "joined" | "expired" | "cancelled" | "revoked";

/** One row, as `listReferrals` returns it. */
export interface ReferralRow {
  id: string;
  email: string;
  inviterUserId: string;
  inviterHandle: string | null;
  inviterUsed: number;
  inviterTotal: number;
  sentAt: number;
  expiresAt: number;
  status: ReferralStatus;
  joinedHandle: string | null;
}

export type ReferralCounts = Record<ReferralStatus, number>;

export type ReferralFilter = "all" | ReferralStatus;

/** The sub-filters, in the order they are shown. */
export const REFERRAL_FILTERS: readonly { key: ReferralFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Not used yet" },
  { key: "joined", label: "Joined" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
  { key: "revoked", label: "Revoked" },
];

/** Every referral the server counted, whatever its state. */
export function totalReferrals(counts: ReferralCounts | undefined): number {
  if (counts === undefined) return 0;
  return counts.pending + counts.joined + counts.expired + counts.cancelled + counts.revoked;
}

/** The count beside a sub-filter. */
export function filterCount(counts: ReferralCounts, filter: ReferralFilter): number {
  return filter === "all" ? totalReferrals(counts) : counts[filter];
}

/** The rows a sub-filter keeps. */
export function filterReferrals(rows: readonly ReferralRow[], filter: ReferralFilter): ReferralRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.status === filter);
}

/** `@maya`, or a plain word when the person has no handle yet. */
export function handle(name: string | null): string {
  return name === null ? "someone without a username" : `@${name}`;
}

/** The status pill's words and tone. */
export function statusPill(status: ReferralStatus, joinedHandle: string | null): { label: string; tone: PillTone } {
  switch (status) {
    case "pending":
      return { label: "Not used yet", tone: "warn" };
    case "joined":
      return { label: joinedHandle === null ? "Joined" : `Joined @${joinedHandle}`, tone: "ok" };
    case "expired":
      return { label: "Expired", tone: "neutral" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "revoked":
      return { label: "Revoked", tone: "crit" };
  }
}

/** `@maya · 2 used of 3`. */
export function byLine(row: Pick<ReferralRow, "inviterHandle" | "inviterUsed" | "inviterTotal">): string {
  return `${handle(row.inviterHandle)} · ${row.inviterUsed} used of ${row.inviterTotal}`;
}

/** The in-place question before Revoke. */
export function revokeQuestion(row: Pick<ReferralRow, "email" | "inviterHandle">): string {
  return `Revoke the invite to ${row.email}? The link stops working now. ${handle(row.inviterHandle)} doesn't get it back. Nobody is emailed.`;
}

/** After Revoke, in what the server said changed. */
export function revokedSentence(changed: boolean, email: string): string {
  return changed ? `Revoked the invite to ${email}.` : `The invite to ${email} was already used or stopped.`;
}

/** The amounts "Give more" offers. */
export const GRANT_AMOUNTS: readonly number[] = [1, 3, 5];

/** After a grant. */
export function grantedSentence(add: number, inviter: string | null): string {
  const invites = add === 1 ? "1 more invite" : `${add} more invites`;
  return `Gave ${handle(inviter)} ${invites}. Their count goes up. No email is sent.`;
}

/** `@jon has invited 2 people`. */
export function onwardLine(joinedHandle: string | null, count: number): string {
  const who = joinedHandle === null ? "They have" : `@${joinedHandle} has`;
  return count === 0 ? `${who} not invited anyone yet` : `${who} invited ${people(count)}`;
}

/** The trace's steps after "Invited by", as a label and a date. */
export interface TraceStep {
  label: string;
  at: number | null;
  tone: PillTone;
}

export interface Trace {
  status: ReferralStatus;
  inviterHandle: string | null;
  sentAt: number;
  expiresAt: number;
  cancelledAt: number | null;
  revokedAt: number | null;
  joinedAt: number | null;
  joinedHandle: string | null;
}

/** The vertical timeline, oldest first. */
export function traceSteps(trace: Trace): TraceStep[] {
  const steps: TraceStep[] = [
    { label: `Invited by ${handle(trace.inviterHandle)}`, at: trace.sentAt, tone: "neutral" },
  ];
  switch (trace.status) {
    case "joined":
      steps.push({
        label: trace.joinedHandle === null ? "Joined" : `Joined as @${trace.joinedHandle}`,
        at: trace.joinedAt,
        tone: "ok",
      });
      break;
    case "cancelled":
      steps.push({ label: "Cancelled", at: trace.cancelledAt, tone: "neutral" });
      break;
    case "revoked":
      steps.push({ label: "Revoked", at: trace.revokedAt, tone: "crit" });
      break;
    case "expired":
      steps.push({ label: "Expired", at: trace.expiresAt, tone: "neutral" });
      break;
    case "pending":
      steps.push({ label: `Not used yet · expires ${shortDate(trace.expiresAt)}`, at: null, tone: "warn" });
      break;
  }
  return steps;
}

// -- community links -------------------------------------------------------

export type CommunityKind = "discord" | "github" | "x" | "newsletter" | "other";
export type CommunityAudience = "members" | "everyone";

/** One link, as `listCommunityLinks` returns it. */
export interface CommunityLink {
  id: string;
  kind: CommunityKind;
  label: string;
  url: string;
  audience: CommunityAudience;
  position: number;
}

export const COMMUNITY_KINDS: readonly { key: CommunityKind; label: string }[] = [
  { key: "discord", label: "Discord" },
  { key: "github", label: "GitHub" },
  { key: "x", label: "X" },
  { key: "newsletter", label: "Newsletter" },
  { key: "other", label: "Other" },
];

export const COMMUNITY_AUDIENCES: readonly { key: CommunityAudience; label: string }[] = [
  { key: "members", label: "Signed-in people only" },
  { key: "everyone", label: "Everyone" },
];

export function audienceLabel(audience: CommunityAudience): string {
  return audience === "members" ? "Signed-in people only" : "Everyone";
}

/**
 * What the form fills in when a kind is picked. A Discord invite is for
 * people who are in, so it defaults to signed-in only; the rest default to
 * everyone. "Other" has no name to suggest.
 */
export function kindDefaults(kind: CommunityKind): { label: string; audience: CommunityAudience } {
  const label = kind === "other" ? "" : (COMMUNITY_KINDS.find((entry) => entry.key === kind)?.label ?? "");
  return { label, audience: kind === "discord" ? "members" : "everyone" };
}
