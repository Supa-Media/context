/**
 * What an owner reads when managed storage could not be set up. Split out of
 * `premium.ts`, which re-exports it.
 */

import { foundingAtNoCharge } from "./founding";
import type { PremiumStatus } from "./premium";

/**
 * Whether somebody paid for this storage: a Stripe customer behind a plan that
 * is not founding Premium, the free tier, a test account or staging's free
 * storage. Only then does the failure copy mention a payment. A founder, a
 * free-tier owner or Google's reviewer who never saw a checkout was told
 * "Your payment went through" (2026-10-29), which is false and alarming.
 * Unknown is unpaid: the sentence is never said on a guess.
 */
export function paidForStorage(status: PremiumStatus | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  if (status.freeManaged === true || status.stagingFreeStorage === true || status.isTestAccount === true) return false;
  return status.hasStripeCustomer === true && !foundingAtNoCharge(status);
}

/**
 * Storage could not be made: paid for (`charged`), or free.
 *
 * Paid for, the worst state in the product — money taken, nothing delivered —
 * and the three things this copy has to do, in order:
 *
 * 1. **Say the payment and the notes are safe**, before anything else. With
 *    nothing charged, only the notes: a payment is never named that was not
 *    made.
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
  { charged }: { charged: boolean },
): {
  title: string;
  body: string;
  canRetry: boolean;
} {
  const safe = charged ? "Your payment went through and nothing has been lost." : "Nothing has been lost, and nothing was charged.";
  if (errorCode === "NOT_CONFIGURED") {
    return {
      title: "We cannot set up storage on this deployment yet",
      body: charged
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
