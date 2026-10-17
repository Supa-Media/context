import type { PremiumStatus } from "./premium";

/**
 * FOUNDING PREMIUM, IN THE WORDS A FOUNDER READS.
 *
 * The first 100 accounts are Premium at no charge (`docs/decisions/billing.md`,
 * "Founding Premium"): an active plan marked `founding`, with no Stripe
 * customer behind it. Every screen that would name a price, a subscription or
 * a payment says this one line instead, so nobody who is not paying is told
 * what they pay.
 */
export const FOUNDING_PRICE_LINE = "Founding member: Premium at no charge.";

/**
 * The founders' deal is limited Premium (decided by the owner, 2026-10-17):
 * on storage we run it keeps the free tier's note cap. Said wherever a founder
 * chooses that storage, so the cap is never a surprise later.
 */
export const FOUNDING_NOTES_LINE = "Up to 1,000 notes on storage we run; full Premium lifts the cap.";

/**
 * Where the plan's card would say who is billed. A plan belongs to a workspace,
 * so a shared workspace a founder makes later pays as any other.
 */
export const FOUNDING_BLURB =
  "Granted to this workspace, not to you: a shared workspace you add later has its own plan.";

/**
 * Whether this plan is founding Premium that nobody is paying for.
 *
 * A founder who was already subscribed keeps their Stripe customer and keeps
 * paying until they cancel in the portal, so they are shown the price and the
 * portal as before. Once Stripe says that subscription ended
 * (`subscriptionLive: false`), the customer id is history and they read as any
 * other founder. A control plane older than that field never says false, so
 * the founder keeps the portal rather than losing it by mistake.
 * `hasStripeCustomer` is owner-only; a member, who never sees money facts, is
 * told only that it is founding.
 */
export function foundingAtNoCharge(
  status: Pick<
    PremiumStatus,
    "founding" | "status" | "hasStripeCustomer" | "subscriptionLive"
  > | null,
): boolean {
  return (
    status !== null &&
    status.founding === true &&
    status.status === "active" &&
    (status.hasStripeCustomer !== true || status.subscriptionLive === false)
  );
}
