/**
 * What the browse tool says when its browser can't be handed over, kept out
 * of `browse.js` so that file stays under its size limit.
 */

/*
  NO LINK IS NEVER A REASON TO HAND THE WORK BACK (the owner, 2026-11-12:
  "why can't it do my captchas????"). In a group chat Tex filled a party
  request form, met an image captcha, was asked for a link to it, and, told
  by this file that the browser "can't be handed to the person", texted the
  whole form back to be filled in again by hand. The browser was still open
  where it had got to. So every line here that says no link can be made says
  the browser is kept, and never tells anyone to redo on the site what Tex
  already did there.
*/
/** The gateway's line when a handoff was asked for and no link could be made. */
export const NO_LINK_LINE = "I couldn't make a link to my browser this time. It's kept where it got to, so text me and I'll try the link again.";

/** Said to the model when a handoff step can't make a link: keep the work, never hand it back. */
export const NO_LINK_RESULT =
  "No link to this browser can be made here, and it stays open where it got to. " +
  "Never tell the person to fill in or redo on the site what you already did, and never list a form's answers for them to type again. " +
  "Do everything left yourself; if one step only they can do remains, say in one line what it is and that you've kept the browser.";

/** And when it cannot: a model told a link is coming says so, and none comes. */
export const NO_HANDOFF_SENTENCE =
  "No link to this browser can be sent from here, so never promise one, and never tell the person to fill in or redo on the site what you already did there. " +
  "When one step only they can do is left (a payment, a sign-in only they can finish, a captcha that outlasted every try), say in one line what it is and that you've kept the browser where it got to. " +
  "A one-time code a site sends them is theirs to text you: ask for it, then type it here yourself. ";

/*
  A LINK THEY SAID NO TO IS NEVER SENT AGAIN (the owner's review, 2026-10-26).
  "If you can't book this bus for me yourself, you are useless to me, im not
  opening your browser": Tex had already texted its browser twice in that
  booking, the second time after the first showed a blank screen. Once their
  texts refuse the browser, the handoff step is gone for the conversation the
  gateway sees (`handoffRefusedIn`), and the description says why.
*/
export const REFUSED_HANDOFF_SENTENCE =
  "The person said they won't take over your browser, so there is no handoff step: never offer or send them a link to it, and never ask them to finish on the site themselves. " +
  "Do it yourself (close_popup for a popup in the way, a read with from for elements not listed, fill_card for a saved card); if something truly only they can give is missing, ask for that one thing. ";
export const REFUSED_HANDOFF =
  "Not handed over: the person said they won't take over your browser. Carry on yourself; if one thing only they can give is missing (a code, a yes), ask for that alone.";

/** "im not opening your browser", "I won't use your link", "stop sending me your browser". */
const REFUSES_BROWSER = [
  /\b(?:not|never|won'?t|wont|will not|don'?t|dont|do not|refuse to|am not|i'?m not|im not|stop)\s+(?:going to\s+|gonna\s+)?(?:open(?:ing)?|us(?:e|ing)|click(?:ing)?|tap(?:ping)?|tak(?:e|ing) over|touch(?:ing)?|send(?:ing)?(?: me)?)\s+(?:your|the|that|this|ur|tex'?s)\s+(?:\w+\s+)?(?:browser|link|computer|screen)\b/i,
  /\b(?:i|you)\s+(?:do|book|finish|pay for|buy)\s+it\s+(?:your ?self|ur ?self)\b[^.?!\n]{0,40}\b(?:browser|link)\b/i,
];

/** Whether the person's own texts refuse Tex's browser. */
export function handoffRefusedIn(theirWords) {
  const said = String(theirWords ?? "").replace(/[‘’]/g, "'");
  return REFUSES_BROWSER.some((pattern) => pattern.test(said));
}
