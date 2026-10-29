/**
 * What an owner reads when managed storage could not be set up. Split out of
 * `premium.ts`, which re-exports it.
 */

import { foundingAtNoCharge } from "./founding";
import type { PremiumStatus } from "./premium";

/**
 * What the billing fields prove about money for this storage, and nothing
 * more (2026-10-29: Google's verification reviewer, founding Premium at no
 * charge, was told "Your payment went through" after a checkout they never
 * saw).
 *
 * - `subscribed`: an owner's own Stripe subscription that Stripe still calls
 *   active (`status: "active"` and `subscriptionLive`), not founding at no
 *   charge. That proves a live subscription, not that a payment cleared — a
 *   trial reads as active too — so the copy says only the former.
 * - `none`: provably nothing to charge. No Stripe customer exists for this
 *   plan (owner-only field, so `false` is a statement, not an absence), or
 *   staging's storage, which costs nothing.
 * - `unknown`: everything else — a member who is never shown money facts, a
 *   past or cancelled subscriber, an abandoned checkout that left a customer
 *   behind, a payment that is past due. The copy names no money at all.
 */
export type StorageMoney = "subscribed" | "none" | "unknown";

export function storageMoneyOf(status: PremiumStatus | null | undefined): StorageMoney {
  if (status === null || status === undefined) return "unknown";
  if (status.stagingFreeStorage === true || status.hasStripeCustomer === false) return "none";
  if (
    status.hasStripeCustomer === true &&
    status.subscriptionLive === true &&
    status.status === "active" &&
    !foundingAtNoCharge(status)
  ) {
    return "subscribed";
  }
  return "unknown";
}

/**
 * Storage could not be made, with what is proven about money for it
 * (`storageMoneyOf`).
 *
 * Subscribed, the worst state in the product — a subscription running,
 * nothing delivered — and the three things this copy has to do, in order:
 *
 * 1. **Say the subscription and the notes are safe**, before anything else.
 *    With nothing to charge, say so; with money unknown, only the notes: no
 *    sentence about money is said on a guess.
 * 2. **Say a retry cannot duplicate anything.** That is a fact rather than
 *    reassurance: provisioning adopts the bucket named for this workspace, and
 *    `apps/convex/__tests__/managedProvisioning.test.ts` holds it to that.
 * 3. **Offer the free path out** — connect storage of your own — because it
 *    always works, and somebody stuck here has already waited long enough.
 *
 * The error code is ours and is never rendered: a person reading this cannot
 * act on which of our systems refused, and a provider's own text can name an
 * account. It picks the sentence, and the sentence names the next safe action.
 */
export function managedFailureCopy(
  errorCode: string | undefined,
  { money }: { money: StorageMoney },
): {
  title: string;
  body: string;
  canRetry: boolean;
} {
  const safe =
    money === "subscribed"
      ? "Your subscription is active and nothing has been lost."
      : money === "none"
        ? "Nothing has been lost, and nothing was charged."
        : "Nothing has been lost.";
  if (errorCode === "NOT_CONFIGURED") {
    return {
      title: "We cannot set up storage on this deployment yet",
      body: money === "subscribed"
        ? `${safe} This one is at our end and trying again will not fix it — get in touch and we will sort it ` +
          "out, or connect storage you own and we will stop the subscription."
        : `${safe} This one is at our end and trying again will not fix it — get in touch and we will sort it ` +
          "out, or connect storage you own.",
      canRetry: false,
    };
  }
  if (errorCode === "MOVE_IN_PROGRESS") {
    return {
      title: "Your files are being moved to another bucket",
      body:
        "Nothing has been lost. Context storage is set up once that move has " +
        "finished or been stopped in Settings › Storage; then try again here.",
      canRetry: true,
    };
  }
  return {
    title: "We could not finish setting up your storage",
    body: `${safe} This is our end, not yours — trying again is safe and will not create a second copy of anything.`,
    canRetry: true,
  };
}
