/**
 * Walls a browser meets that an answer may stop at, and when stopping there
 * is too soon: a captcha before the browser's own tries outlasted it, and a
 * passkey page before Google's other ways were ever looked at. Each gives one
 * more round, once a turn. Neither reads a page: only the marks `browse.js`
 * puts on its results, and the answer's own words.
 */

/*
  A captcha is the person's only after the browser tried every way past it
  (the owner, 2026-10-22: "make sure agents try using those bypasses and
  other browserbase hacks before handing back"). The browse tool runs those
  tries itself (`captchaLadder.js`) and marks a result whose captcha outlasted
  them; an answer that hands them a captcha with no such result this turn
  gets one more round.
*/
/** "captcha", and what Tex calls one in plain words: "a picture check keeps rejecting my answers" (2026-10-24, Instacart). */
const CAPTCHA_WORDS = String.raw`(?:captcha|not a robot|robot check|bot check|human check|security check|(?:picture|image|photo|slider) (?:check|test|puzzle|challenge))`;
const CAPTCHA_ASK = new RegExp(
  String.raw`\b(?:solve|tick|check|complete|pass|clear|get (?:past|through)|click|do)\b[^.?!\n]{0,40}\b${CAPTCHA_WORDS}|\b${CAPTCHA_WORDS}[^.?!\n]{0,60}\b(?:you|your|tap|solve|tick|complete)\b`,
  "i",
);

/** Whether an answer asks them to get past a captcha. */
export function handsOverACaptcha(answer) {
  return CAPTCHA_ASK.test(String(answer ?? "").replace(/[\u2018\u2019]/g, "'"));
}

export const CAPTCHA_NOTICE =
  "Before this goes: your answer asks them to get past a captcha, but none outlasted the browser's tries this turn. " +
  "Whenever a page shows a captcha, browse tries Browserbase's solver, a reload and a fresh browser with a new address by itself, so open the page with browse and carry on. " +
  "Only a captcha the browse result says is still there after every try is theirs, and then only with everything else on the page done. " +
  "If those words weren't asking them to solve anything, send your answer again as it was.";
/*
  A passkey page is not the end of a Google sign-in (a tester's chat,
  2026-11-01). A job signing in to a site with "Continue with Google" met
  Google's passkey step, pressed around it, started over twice and texted
  "Google keeps asking for the passkey ... there's no other route". Nothing
  on record says it ever reached Google's list of other ways, which nearly
  always has a password, a code by text or a "tap Yes" prompt on their phone.
  The browser now presses "Try another way" itself (infra/site-shots
  `googleChallenge.ts`); an answer that still stops at a passkey on a turn
  that never saw that list gets one more round.
*/
const PASSKEY = /\bpasskeys?\b/i;
const STOPPED = new RegExp(
  String.raw`\b(?:no other (?:route|way|option|method)s?|only (?:route|way|option)|(?:can't|cannot|couldn't|could not|won't|wouldn't|unable to)\b[^.?!\n]{0,40}\b(?:get (?:past|in|through)|sign (?:you |them )?in|let (?:me|us) in|finish|log (?:you |them )?in)|keeps? asking|still (?:asks|asking|wants|blocked|stuck)|block(?:s|ed|ing)|stuck|hand you (?:the|my) browser|approve it)\b`,
  "i",
);

/** Whether an answer stops at a passkey. */
export function stopsAtAPasskey(answer) {
  const said = String(answer ?? "").replace(/[‘’]/g, "'");
  return PASSKEY.test(said) && STOPPED.test(said);
}

export const PASSKEY_WAYS_NOTICE =
  "Before this goes: your answer stops at a passkey, but this turn never reached Google's list of other ways to sign in. " +
  "On the passkey page, press \"Try another way\" (a browse click by its words) and read the list. " +
  "Pick \"Enter your password\" and fill it with their saved Google login (fill_login), or a code by text or email they can text you, " +
  "or \"Tap Yes on your phone\", which Google sends to their own phone, so tell them to tap Yes. " +
  "Only if that list offers nothing but a passkey, say so in one line and offer them the browser. " +
  "If your answer wasn't stopping at a passkey, send it again as it was.";

/** One turn's watcher: `read` every browser result, then ask `captcha` and `passkey` of an answer. */
export function browserWalls() {
  let captchaStuck = false;
  let captchaNoticed = false;
  let passkeyWall = false;
  let waysSeen = false;
  let passkeyNoticed = false;
  return {
    read(result) {
      if (result?.captchaStuck === true) captchaStuck = true;
      if (result?.passkeyWall === true) passkeyWall = true;
      if (result?.passkeyWaysSeen === true) waysSeen = true;
    },
    captcha(answer) {
      if (captchaNoticed || captchaStuck || !handsOverACaptcha(answer)) return null;
      captchaNoticed = true;
      return CAPTCHA_NOTICE;
    },
    passkey(answer) {
      if (passkeyNoticed || !passkeyWall || waysSeen || !stopsAtAPasskey(answer)) return null;
      passkeyNoticed = true;
      return PASSKEY_WAYS_NOTICE;
    },
  };
}
