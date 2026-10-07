/**
 * The census's waitlist slice: who staff let in, and how far they got.
 *
 * Asked for by Dev2 (2026-10-07): the Accounts roster only ever listed
 * accounts, so somebody let in from the waitlist was invisible on the Growth
 * tab until they signed in — and there was no way to read the funnel for the
 * waitlist alone. Letting somebody in writes a `waitlist` row, never a `users`
 * row; the account appears when they first sign in. This joins the two by
 * address so the console can show both halves.
 *
 * "From the waitlist" means an `admitted` waitlist row exists for the
 * account's address (any source, staff-added included: the console's Add
 * emails is letting somebody in from the list). An account that arrived by a
 * workspace invitation, a friend's referral or the staff allowlist has no
 * such row and is not counted. A row staff later removed is not admitted and
 * does not count either.
 *
 * Metadata only, like the rest of the census: an address and two timestamps.
 */

import { normalizeEmail } from "@context/shared";
import { v } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { CENSUS_CEILING, funnelOf, pageOf, totalOf, type AccountFacts, type CountedTotal } from "../census";
import { countedTotalValidator } from "./usage";

/** How many let-in-but-not-signed-up people the console names. */
export const NOT_SIGNED_UP_LIMIT = 50;

export const censusWaitlistValidator = v.object({
  /** Every admitted waitlist row; a floor past `CENSUS_CEILING`. */
  letIn: countedTotalValidator,
  /** How many of them have an account. */
  signedUp: v.number(),
  /** The account funnel over waitlist accounts only, `let-in` first. */
  funnel: v.array(v.object({ step: v.string(), count: v.number() })),
  /** Newest let in first, at most `NOT_SIGNED_UP_LIMIT`. */
  notSignedUp: v.array(v.object({ email: v.string(), letInAt: v.number() })),
  notSignedUpTotal: v.number(),
});

/** The admitted rows, keyed by normalized address, newest first. */
export async function admittedWaitlist(ctx: QueryCtx) {
  const page = pageOf(
    await ctx.db
      .query("waitlist")
      .withIndex("by_status_joinedAt", (q) => q.eq("status", "admitted"))
      .order("desc")
      .take(CENSUS_CEILING + 1),
  );
  const byEmail = new Map<string, Doc<"waitlist">>();
  for (const row of page.rows) byEmail.set(normalizeEmail(row.email), row);
  return { page, byEmail };
}

/** When this account's address was let in, or `null` when it never was. */
export function letInAtFor(
  byEmail: ReadonlyMap<string, Doc<"waitlist">>,
  email: string | undefined,
): number | null {
  if (typeof email !== "string") return null;
  const row = byEmail.get(normalizeEmail(email));
  if (row === undefined) return null;
  return row.admittedAt ?? row.joinedAt;
}

export function waitlistSummary(
  admitted: Awaited<ReturnType<typeof admittedWaitlist>>,
  accountEmails: ReadonlySet<string>,
  waitlistFacts: readonly AccountFacts[],
): {
  letIn: CountedTotal;
  signedUp: number;
  funnel: { step: string; count: number }[];
  notSignedUp: { email: string; letInAt: number }[];
  notSignedUpTotal: number;
} {
  const pending = [...admitted.byEmail.entries()]
    .filter(([email]) => !accountEmails.has(email))
    .map(([email, row]) => ({ email, letInAt: row.admittedAt ?? row.joinedAt }))
    .sort((a, b) => b.letInAt - a.letInAt);
  const letIn = totalOf(admitted.page);
  return {
    letIn,
    signedUp: waitlistFacts.length,
    funnel: [{ step: "let-in", count: letIn.count }, ...funnelOf(waitlistFacts)],
    notSignedUp: pending.slice(0, NOT_SIGNED_UP_LIMIT),
    notSignedUpTotal: pending.length,
  };
}
