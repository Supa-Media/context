/**
 * THE BROWSER IS HANDED OVER ONLY FOR WHAT THE PAGE SHOWS IS THE PERSON'S
 * (the owner, 2026-10-27: "why is my tex asking me to complete a regular
 * form myself?").
 *
 * The person had answered the four questions a church conference's
 * registration form asked. Tex typed their name and email, ticked the
 * answers, chose "Graduated" for school, pressed Register, and when that
 * click ran out of time it looked twice, clicked twice more and added a
 * handoff step. The gateway texted "Open this to take over the browser" the
 * moment the link existed, mid-turn, so no check on the answer could stop it:
 * the hand-back judge reads only what the model writes.
 *
 * So the handoff step is checked here, against the reading the steps before
 * it left, before any link is made. It goes ahead only for the fair asks of
 * docs/decisions/texting-assistant/handing-back.md that a page can show:
 *
 * - K1, a sign-in: a password box, or a page whose title or address says it
 *   is a sign-in or a consent screen (an email-first sign-in has no password
 *   box yet);
 * - K2, a code or an approval on their phone: a code box, or the page asking
 *   for one;
 * - K3, a captcha: one that outlasted every try (`captchaLadder.js`), or a
 *   page that still says it is one;
 * - Y1, money: card boxes, or a payment frame;
 * - or their own words this question asking to do it themselves.
 *
 * Anything else (a form, a picker, a button that did nothing, a page that
 * says a box is missing) is Tex's, and the step is refused with what to do
 * instead. A fact only they know is still a fair ask, and goes in a text,
 * where the hand-back judge reads it.
 *
 * Nothing here is shown to a model as a rule it could argue with: the page's
 * words decide, and a page that wants the browser handed over can at most
 * get the handoff the decision already allows for a sign-in or a payment.
 */

/** A box for a password ("input password" from the browser, "textbox (password)" from the bench's scripted sites). */
const PASSWORD_KIND = /\bpassword\b/i;
/** A sign-in or consent page, by its title or its address: an email-first sign-in shows no password box yet. */
const SIGN_IN_TITLE = /\b(?:log ?in|sign ?in|log ?on|allow|authori[sz]e|consent|verify it'?s you)\b/i;
const SIGN_IN_PATH = /\/(?:login|log-in|signin|sign-in|sign_in|auth|oauth2?|authorize|sso|consent)(?:[/?#.]|$)/i;

/** A box to type in. */
const TYPING_KIND = /^(?:input|textbox|textarea)\b/i;

/** A box for a one-time code, and the codes a form asks for that are not one. */
const CODE_LABEL = /\b(?:one[- ]time|verification|2fa|two[- ]factor|otp|passcode|authenticat\w*)\b|\bcode\b/i;
const NOT_A_SIGN_IN_CODE = /\b(?:zip|postal|post|promo|promotion|discount|coupon|area|country|referral|gift|invite|invitation|group|event|tax|vat|swift|sort|dress)\s*code\b/i;

/** A page asking for a code, or an approval on their phone. */
const CODE_TEXT =
  /\b(?:enter (?:the|your|a) (?:\d-digit )?code|(?:we|we've|we have) (?:just )?sent (?:you )?(?:a|an|the) (?:code|text|email)|verification code|two[- ]factor|2-step verification|verify it'?s you|confirm it'?s you|approve (?:the |this )?(?:sign[- ]in|request|login)|check your (?:phone|device|authenticator))\b/i;

/** A page that is a captcha wall. */
const CAPTCHA_TEXT = /\b(?:captcha|i'?m not a robot|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|press (?:&|and) hold|security check to continue)\b/i;

/** A box or a frame for a card, and a page that asks for one. */
const CARD_LABEL = /\b(?:card ?number|credit card|debit card|name on card|expiry|expiration|exp\.? date|cvc|cvv|security code|cc-\w+)\b/i;
const CARD_TEXT = /\b(?:card number|credit card|debit card|name on card|cvc|cvv|paypal|apple pay|google pay|payment method)\b/i;

/** Their own words asking to do it themselves. */
const THEIR_OWN = /\b(?:my ?self|i'?ll (?:do|finish|sign|log|pay|fill|type|enter|handle)|let me (?:do|finish|sign|log|pay|fill|type|enter|handle)|i'?d rather|send me (?:the|your) (?:browser|link)|i (?:want|wanna) to (?:do|sign|log|pay|fill))\b/i;

/** Said when a handoff was asked for and nothing on the page is the person's. */
export const NOT_THEIRS =
  "\n\nNot handed over: nothing on this page is the person's to do. There is no sign-in, code, captcha or card box, so the browser stays yours. " +
  "Finish it yourself: fill every box from what they told you and their notes, choose options by select or a click on the option's words, " +
  "take a look and click at x and y for anything without a number, close_popup for a popup in the way, a read with from for elements not listed, " +
  "then press the page's own button (Submit, Register, Continue) and read the page to see whether it went through or what it says is missing. " +
  "A click that ran out of time may still have worked: read before you press it again. " +
  "If one fact only they know is still missing, ask them for that one fact in your reply; never send them the browser for it.";

/**
 * Whether the page, or the person, makes this handoff a fair ask. `reading`
 * is the browser's reading after the steps; `stuck` whether a captcha this
 * question outlasted every try; `theirWords` the person's own words this
 * question.
 */
export function handoffIsTheirs({ reading, stuck = false, theirWords = "" }) {
  if (stuck) return true;
  if (THEIR_OWN.test(String(theirWords ?? "").replace(/[‘’]/g, "'"))) return true;
  if (SIGN_IN_TITLE.test(String(reading?.title ?? ""))) return true;
  try {
    if (SIGN_IN_PATH.test(new URL(reading?.url).pathname)) return true;
  } catch {
    // No address: the page's boxes and words decide.
  }
  const elements = Array.isArray(reading?.elements) ? reading.elements : [];
  const text = typeof reading?.text === "string" ? reading.text : "";
  for (const element of elements) {
    const kind = String(element?.kind ?? "");
    const label = String(element?.label ?? "");
    if (PASSWORD_KIND.test(kind)) return true;
    if (!TYPING_KIND.test(kind)) continue;
    if (CODE_LABEL.test(label) && !NOT_A_SIGN_IN_CODE.test(label)) return true;
    if (CARD_LABEL.test(label)) return true;
  }
  return CODE_TEXT.test(text) || CAPTCHA_TEXT.test(text) || CARD_TEXT.test(text);
}
