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
