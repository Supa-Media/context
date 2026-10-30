/**
 * Two dead ends a browser page can lead Tex into, said in the browser's own
 * answer so the model sees them before it texts anyone (a tester's chat,
 * 2026-10-29, about a Google Form's sign-ups).
 *
 *  1. A passkey page ("Complete sign-in using your passkey"). A passkey
 *     lives on the person's own devices, and a request from this browser
 *     never reaches their phone. Asking them to approve one asks for
 *     something that can't arrive. The page offers "Try another way".
 *
 *  2. A form editor address built by hand. A Google Form's published link
 *     (`/forms/d/e/1FAIpQL…/viewform`) carries its published id, which is not
 *     the id its editor and responses live under, so swapping in `/edit` or
 *     `/responses` opens nothing of theirs. The real one comes from their
 *     Drive, an email from Google Forms, or the form's own sharing link.
 */

/** Google's passkey step, and the other sites that word it the same way. */
const PASSKEY_WALL = /\b(?:complete sign-?in using your passkey|use your passkey|sign in with (?:a|your) passkey|verify (?:it'?s you )?with (?:a|your) passkey|passkey)\b/i;

export const PASSKEY_LINE =
  "This page asks for a passkey. A passkey sits on the person's own devices, and a request from this browser never reaches their phone, " +
  "so never ask them to approve it. Pick another way on this page now: \"Try another way\", then their password (fill_login), or a code by text or email they can text you. " +
  "Only if the page offers nothing else, hand them the browser to finish.";

/** The line a reading carries when its page is a passkey wall; empty otherwise. */
export function passkeyLine(text) {
  return PASSKEY_WALL.test(String(text ?? "")) ? PASSKEY_LINE : "";
}

/** A published form id (`1FAIpQL…`) in an editor or responses address, or a published address with /edit or /responses. */
const BUILT_FORM_LINK = /^https:\/\/docs\.google\.com\/forms\/(?:u\/\d+\/)?d\/(?:e\/[^/]+\/(?:edit|responses)|1FAIpQL[^/]*\/(?:edit|responses|viewanalytics))/i;

/** Whether an address is a Google Form editor or responses link built from the form's published link. */
export function builtFormLink(url) {
  return BUILT_FORM_LINK.test(String(url ?? ""));
}

export const BUILT_FORM_LINK_ERROR =
  "That form address is built from the form's published link, and a published form id never opens its editor or responses. " +
  "Find the real one: search their email for the form's title (Google Forms and Drive send the edit link), or open Google Drive or forms.google.com in this browser signed in as them and open the form from there.";
