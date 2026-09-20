/**
 * Shared links — every live grant an owner has minted over one note, and the
 * Revoke that takes each one back.
 *
 * `apps/convex/functions/shares.ts` is the whole of what this answers: a share
 * is deliberately not a membership, so "who can reach this context" (People)
 * and "what have I handed to somebody outside it, one note at a time" (this)
 * are two different questions with two different lists. Before this file, the
 * second question had a backend and no console — `listShares` and
 * `revokeShare` existed and nothing subscribed to either, so an owner had no
 * way to see, let alone take back, a link they had pasted into a chat months
 * ago.
 *
 * Pure and React-free, like `members.ts`: the awkward cases — an unlisted link
 * with nobody to name, an expiry that has already passed, a revoke the backend
 * refused — are pinned by tests rather than discovered in a screenshot.
 *
 * The rule this file is built on is the one `StorageActions` and `MembersView`
 * already state: **an owner-only control is absent, not disabled.**
 * `listShares` and `revokeShare` are both owner-only on the backend — see that
 * module's own doc comment on why enumerating shares is the owner's disclosure
 * record and nobody else's — so `SharesView.actions` is the entire object,
 * present or not, never a button that renders and refuses.
 */

import type { ConsoleFailure } from "../failure";

/** Which kind of audience a share addresses. Mirrors `noteShares.recipientKind`. */
export type ShareAudience = "name" | "email" | "members" | "anyone";

/** One row of `listShares`, exactly as the control plane returns it. */
export interface ConsoleShare {
  shareId: string;
  /**
   * The link itself. Present here for the reason `shareSummary` gives: this
   * list is owner-only, and the owner is who `createShare` handed the token to
   * in the first place.
   */
  token: string;
  /** Already decorated by the backend: `@lk`, a bare address, "Anyone with access", or "Anyone with the link". */
  recipient: string;
  audience: ShareAudience;
  entryPath: string;
  titleInPreview: boolean;
  previewTitle?: string;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Owner-only. Absent — the whole object — for anyone else, and in the demo.
 *
 * `revokeShare` is immediate and final for that token: re-sharing the same
 * note to the same recipient mints a brand-new link rather than reviving this
 * one.
 */
export interface ShareActions {
  revoke: (shareId: string) => Promise<void>;
}

export interface SharesView {
  shares: ConsoleShare[];
  /** Absent for anyone who is not the owner of this context, and in the demo. */
  actions?: ShareActions;
  loading: boolean;
  /**
   * Set when `listShares` came back as an error rather than a list.
   *
   * Reaches this view as a *value*, the same discipline `MembersView.failure`
   * documents — `useShares` subscribes with `useQueries`, never `useQuery`,
   * because a thrown query there re-throws during render and would take the
   * whole console down rather than this one card.
   */
  failure: ConsoleFailure | null;
  /** Shown instead of the controls when they are absent for a real reason. */
  readOnlyReason?: string;
}

/** Whether a role may see and revoke this context's shared links. Owner, and only owner. */
export function canManageShares(role: string | undefined): boolean {
  return role === "owner";
}

/**
 * A dot's tone for how far a share reaches, widest first.
 *
 * `anyone` is the one row that needs no sign-in at all — the single exception
 * `CLAUDE.md`'s non-negotiable #5 carves out of "`team` never means public" —
 * so it is the row worth a second look, not the named ones beside it.
 */
export function shareTone(audience: ShareAudience): "ok" | "warn" | "neutral" {
  return audience === "anyone" ? "warn" : "neutral";
}

/**
 * "expires in 6 days" / "expires today" / "no expiry".
 *
 * `expiresAt` is optional on the row — most shares never carry one — so
 * "no expiry" has to be its own sentence rather than a fallthrough of the
 * arithmetic below, which would otherwise have nothing to subtract from.
 */
export function shareLifetime(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "no expiry";
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export interface ShareFailure {
  headline: string;
  next?: string;
}

/** The `code` on a thrown `ConvexError`, when there is one. */
function errorCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * A backend refusal, turned into something a person can act on.
 *
 * Same rule `members.ts`'s `describeMembersFailure` states: **the code
 * decides what to do next, the message says what happened.** Never the raw
 * thrown text for an unknown failure.
 *
 * `SHARE_NOT_FOUND` covers "no such share", "not yours" and "already revoked"
 * with one answer on purpose — see `shareNotFound()` in `shares.ts` — so this
 * gives it one sentence rather than guessing which of the three actually
 * happened.
 */
export function describeShareFailure(error: unknown): ShareFailure {
  switch (errorCodeOf(error)) {
    case "SHARE_NOT_FOUND":
      return {
        headline: "That link is no longer there",
        next: "It may already have been revoked elsewhere. Reload the list and try again.",
      };
    case "INSUFFICIENT_ROLE":
      return {
        headline: "Only an owner can revoke a shared link",
        next: "Ask an owner of this context to revoke it.",
      };
    case "WORKSPACE_NOT_FOUND":
      return {
        headline: "This context is no longer available to you",
        next: "You may have been removed from it. Pick a different one.",
      };
    case "NOT_AUTHENTICATED":
      return { headline: "You are signed out", next: "Sign in and try again." };
    default:
      return {
        headline: "That did not work",
        next: "Try again in a moment.",
      };
  }
}
