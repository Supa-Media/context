/**
 * TWO WAYS A TEXTED ANSWER IGNORES WHAT THE PERSON JUST SAID (a tester's
 * chats, 2026-10-28 and 2026-10-29). Each is judged on their words and the
 * draft, and each gives the model one more round with a notice
 * (`replyChecks.js`).
 *
 *  1. They say a prompt, code or notification never reached them, and the
 *     answer asks them to approve it again. Tex's browser had stopped on a
 *     passkey page, and Tex asked for the same approval several times after
 *     being told nothing had arrived. A step the person says didn't work is
 *     a reason to change approach, never to repeat it.
 *
 *  2. They turn down a method, and the answer drops the goal. Offered a
 *     manual nightly step to log a laptop's screen time, they said no, and
 *     Tex took the laptop out of their tracking. They rejected the method,
 *     not the goal.
 */

/** "I got no Google prompt", "nothing came", "not getting any notification", "never got the code". */
const NEVER_ARRIVED = new RegExp(
  String.raw`\b(?:(?:got|get|getting|received|receiving|see|seeing|saw)\s+no|(?:didn'?t|did not|don'?t|do not|haven'?t|have not|never|not|nit|isn'?t|aren'?t)\s+(?:get|got|getting|receive|received|receiving|see|seeing|seen|saw|come|came|coming|show|showing|pop|popped|appear|appeared))\b` +
    String.raw`[^.?!\n]{0,40}?\b(?:prompt|notification|notif|code|text|alert|request|approval|passkey|push|pop-?up)s?\b` +
    String.raw`|\b(?:no|nothing|no such)\s+(?:google\s+)?(?:prompt|notification|notif|code|alert|request|pop-?up)s?\s+(?:came|come|arrived|showed|popped|appeared|here)\b` +
    String.raw`|\bnothing\s+(?:came|popped up|showed up|arrived)\b`,
  "i",
);

/** The answer asks them, again, to approve, tap or open the prompt, or to check a device for it. */
const ASKS_TO_APPROVE =
  /\b(?:approve|accept|confirm|tap|open|allow)\b[^.?!\n]{0,40}?\b(?:prompt|passkey|notification|request|sign-?in|it)\b|\bcheck\s+(?:your|the)\s+(?:phone|iphone|ipad|mac|device|devices)\b|\b(?:waiting|still waiting)\s+on\s+(?:your|the)\s+(?:passkey|approval|prompt)\b/i;

/** Whether they said the prompt never came and the answer asks them to approve it anyway. */
export function repeatsUnarrivedPrompt(question, answer) {
  return NEVER_ARRIVED.test(words(question)) && ASKS_TO_APPROVE.test(words(answer));
}

export const NO_PROMPT_NOTICE =
  "Before this goes: they told you the prompt, code or notification never reached them, and your answer asks them to approve or look for it again. " +
  "Don't ask again: that step didn't work. Change the approach now in your browser: read the page first, then pick another way it offers " +
  "(\"Try another way\", \"Use your password\", a code by text or email, their saved login with fill_login), or resend once if that's all it offers. " +
  "A passkey request from your browser never reaches their phone, so never ask them to approve one. " +
  "Then answer with what the page shows now and the one thing, if any, they have to do. If nothing else is offered, say so plainly in one line.";

/** "I'm not doing that", "I don't want", "that's absurd", "too much work": the way offered, turned down. */
const TURNS_DOWN =
  /\b(?:i'?m not (?:doing|going to|gonna)|i (?:won'?t|will not|don'?t want to|do not want to|refuse to)|(?:not|never) (?:doing|gonna do) (?:that|this|it)|that'?s (?:absurd|ridiculous|too much)|too (?:much work|many steps|manual)|no (?:manual|extra) steps?|i don'?t like (?:that|this|it|them|shortcuts))\b/i;

/** The answer takes the thing out: "left the Mac out", "dropped", "removed", "isn't tracked", "stopped tracking". */
const DROPS_IT =
  /\b(?:left|leaving|taken|took|keeping)\s+(?:\w+\s+){0,4}?out\b|\b(?:dropped|removed|stopped tracking|no longer track(?:ing|s)?|won'?t track)\b|\b(?:isn'?t|is not|aren'?t|are not|won'?t be|will not be)\s+(?:being\s+)?(?:tracked|logged|counted|included)\b/i;

/** Whether they turned down a way of doing something and the answer drops the thing itself. */
export function dropsTheGoal(question, answer) {
  return TURNS_DOWN.test(words(question)) && DROPS_IT.test(words(answer));
}

export const GOAL_NOTICE =
  "Before this goes: they turned down the way you suggested, not what it was for, and your answer drops the thing itself from their plan. " +
  "Keep the goal. Find a way that needs nothing from them each time (something that runs or sends by itself), and offer that, never one they already turned down in this chat. " +
  "If you know of none, say so plainly and ask whether they want it dropped; never take it out of their plan on your own.";

function words(text) {
  return String(text ?? "").replace(/[‘’]/g, "'");
}
