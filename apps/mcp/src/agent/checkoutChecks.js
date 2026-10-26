/**
 * A CHECKOUT IS TEX'S TO FINISH, AND WHAT IT SAYS ABOUT ONE IS TRUE (the
 * owner's review, 2026-10-26: a Vamoose bus booking).
 *
 * Asked to book two buses, Tex first said it couldn't find Sunday's times "on
 * Vamoose's site", so "the Sunday schedule still needs checking at
 * vamoosebus.com", having only read the stops page; it had never searched the
 * booking page, as it admitted a text later. Then, with the Chase Visa saved
 * and allowed, it texted "Put in your Chase Visa ending 4813, tick the terms
 * box and press Purchase now". Two checks, read by `claimCheck.js`:
 *
 *   1. An answer that says it couldn't find something on a site, or that it
 *      still needs checking there, with the browser never used this turn,
 *      gets one more round telling Tex to open the site and look. A booking
 *      site shows its times only after a search, which reading a page
 *      (`open_page`) does not do.
 *   2. An answer that tells them to type their card, tick the terms or press
 *      the pay button, in a turn that can fill a saved card (`fill_card`),
 *      gets one more round: the card is filled on their yes and the button is
 *      Tex's to press. A payment with no card saved is still theirs to give,
 *      by saving one (`vault_add`), never by typing it.
 */

/** "I couldn't find Sunday's times on Vamoose's site", "the schedule still needs checking at vamoosebus.com". */
const NOT_LOOKED = [
  /\b(?:couldn't|could not|can't|cannot|didn't|did not|wasn't able to|was unable to)\s+(?:find|see|get|pull up|locate)\b[^.?!\n]{0,80}\b(?:on|at|from|in)\s+(?:[\w.'-]+\s+){0,3}?(?:site|website|page|booking page)\b/i,
  /\b(?:still\s+)?needs?\s+(?:checking|to be checked|confirming|to be confirmed|verifying|to be verified)\b[^.?!\n]{0,40}\b(?:on|at)\s+(?:[\w.'-]+\s+){0,2}?(?:site|website|page|[a-z0-9-]+\.(?:com|net|org|co|io|app))\b/i,
];

/** Whether an answer says something on a site wasn't found, or is still to be checked there. */
export function saysNotFoundOnSite(answer) {
  const said = String(answer ?? "").replace(/[‘’]/g, "'");
  return NOT_LOOKED.some((pattern) => pattern.test(said));
}

export const LOOK_ON_SITE_NOTICE =
  "Before this goes: your answer says something wasn't found on a site, or still needs checking there, but your browser never opened it this turn. " +
  "Reading a page is not searching it: a booking or shop site shows its times and prices only after you pick the route and date. " +
  "Open it with send action browse now, search it the way a person would, and answer with what it shows. Never leave the checking to them. " +
  "If your answer wasn't about a site, send it again as it was.";

/** "Put in your Chase Visa", "enter your card", "tick the terms box and press Purchase now". */
/** Not what Tex says it will do itself: "I'll fill in the card", "I'll tick the terms and press Purchase". */
const NOT_TEX = String.raw`(?<!\bI(?:'ll| will| can|'d| would|'m going to| am going to)\s+(?:then\s+|just\s+|also\s+)?)`;
const CARD_HANDBACK = [
  new RegExp(NOT_TEX + String.raw`\b(?:put|enter|type|fill|key|add)\s+(?:in\s+)?(?:your|the)\s+(?:[\w-]+\s+){0,3}?(?:card|visa|mastercard|amex|card number|card details|payment details)\b`, "i"),
  new RegExp(NOT_TEX + String.raw`\b(?:tick|check)\s+the\s+(?:terms|agree)\b[^.?!\n]{0,60}\b(?:press|click|tap|hit)\b`, "i"),
  /^(?:then\s+|and\s+|just\s+)?(?:press|click|tap|hit)\s+(?:the\s+)?["“]?(?:purchase|pay|buy|place (?:my |your )?order|complete (?:purchase|order|booking)|book now|confirm (?:and|&) pay|checkout)\b/i,
];

/** Whether an answer hands them the card or the pay button. */
export function handsBackThePayment(answer) {
  return String(answer ?? "")
    .replace(/[‘’]/g, "'")
    .split(/\n+|(?<=[.!?])\s+/)
    .some((sentence) => CARD_HANDBACK.some((pattern) => pattern.test(sentence.trim())));
}

export const CARD_NOTICE =
  "Before this goes: your answer asks them to type their card, tick the terms or press the pay button, and those are yours. " +
  "With a card saved (fetch vault:), fill_card fills it once they allow that card on that site; then tick the terms and press the pay button yourself with send action browse, after telling them the total. " +
  "If the card boxes or the button have no number, a read step with from lists the rest of the page, and close_popup clears a popup in the way; if a fill failed, read the page and fill again. " +
  "With no card saved, send manage action vault_add's link with type card, never ask for the number. Never send them your browser to pay. " +
  "If your answer wasn't asking them to pay themselves, send it again as it was.";
