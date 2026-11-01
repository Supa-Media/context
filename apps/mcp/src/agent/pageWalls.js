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
  "so never ask them to approve it. Pick another way on this page now: press \"Try another way\" (a click by its words), then their password (fill_login), a code by text or email they can text you, or a \"tap Yes\" prompt Google sends to their phone. " +
  "Only if the page offers nothing else, hand them the browser to finish.";

/** Google's list of ways to sign in, and its steps past the passkey one (a password, a code, a prompt on their phone). */
const GOOGLE_WAYS = /^https:\/\/accounts\.google\.com\/.*\/challenge\/(?:selection|pwd|ipp|dp|az|totp|bc|sk|iap)\b/i;
const WAYS_WORDS = /\bchoose how you want to sign in\b/i;

export const WAYS_LINE =
  "This is Google's list of ways to sign in. Pick \"Enter your password\" and fill it with their saved Google login (fill_login); else a code by text or email they can text you, " +
  "or \"Tap Yes on your phone\", which Google sends to their own phone, so tell them to tap Yes. Never pick a passkey: it can't reach them from this browser.";

const onGoogle = (url) => /^https:\/\/accounts\.google\.com\//i.test(String(url ?? ""));
/** Whether a page is Google's list of ways to sign in. */
const googleWays = (text, url) => onGoogle(url) && (/\/challenge\/selection\b/i.test(String(url)) || WAYS_WORDS.test(String(text ?? "")));
/** Whether a page is past Google's passkey step: its list of other ways, or one of them. */
const pastThePasskey = (text, url) => GOOGLE_WAYS.test(String(url ?? "")) || googleWays(text, url);

/** The line a reading carries on a passkey wall, or on Google's list of other ways; empty otherwise. */
export function passkeyLine(text, url = "") {
  if (googleWays(text, url)) return WAYS_LINE;
  if (pastThePasskey(text, url)) return "";
  return PASSKEY_WALL.test(String(text ?? "")) ? PASSKEY_LINE : "";
}

/**
 * The marks a browser result carries for the answer check (`browserWalls.js`):
 * a passkey wall met, and Google's other ways reached.
 */
export function passkeyMarks(reading) {
  if (pastThePasskey(reading?.text, reading?.url)) return { passkeyWaysSeen: true };
  return PASSKEY_WALL.test(String(reading?.text ?? "")) ? { passkeyWall: true } : {};
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
