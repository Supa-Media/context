/**
 * NO EXTRA OFFER AFTER THE WORK IS DONE (2026-11-17).
 *
 * A finished change gets the fact of what changed, and then stops. An offer
 * still belongs when the next step needs their yes (an email, a calendar
 * change, a Slack post, a payment, a bug report): those are held, and the
 * existing offer check raises the hold. What this catches is the other one:
 * the write already went through, nothing is waiting on them, and the reply
 * still asks "want me to" do something further.
 *
 * The caller decides the work is done (`wrote && !held`). This only reads
 * the reply.
 */

const EXTRA = /\b(?:want me to|shall I|should I|do you want me to|would you like me to)\b[^?\n]{0,180}\?/i;

/** An offer the hold check already owns. Naming one here would ask twice. */
const HELD_KIND = /\b(?:emails?|e-mails?|calendar|slack|pay|payment|bug)\b/i;

export const FINISHED_OFFER_NOTICE =
  "Before this goes: the change is already made, and nothing is waiting on them. " +
  "End on what you did. Don't add an offer of something further.";

/**
 * The send-back when a finished reply still offers more, or null. An offer
 * to send mail, change the calendar, post to Slack, pay or file a bug is
 * left to the hold check.
 */
export function finishedOfferNotice(answer) {
  const offer = String(answer ?? "").match(EXTRA);
  if (!offer || HELD_KIND.test(offer[0])) return null;
  return FINISHED_OFFER_NOTICE;
}
