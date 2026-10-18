import { foundingAtNoCharge } from "./founding";
import type { PremiumStatus } from "./premium";

/** When the current period ends, in a sentence, or `null`. */
export function renewalLine(
  status: PremiumStatus,
  now = Date.now(),
): string | null {
  // Nobody is billed: a past period is history, not something to tell them.
  if (status.currentPeriodEnd === undefined || foundingAtNoCharge(status)) return null;
  const at = new Date(status.currentPeriodEnd * 1000);
  if (Number.isNaN(at.getTime())) return null;
  const on = at.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  if (status.cancelAtPeriodEnd === true) {
    // A founder who cancels stops paying and keeps Premium.
    return status.founding === true
      ? `Billing stops on ${on}. Premium stays: you are a founding member.`
      : `Premium ends on ${on}.`;
  }
  return status.currentPeriodEnd * 1000 < now
    ? `The period that was paid for ended on ${on}.`
    : `Renews on ${on}.`;
}
