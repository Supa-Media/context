/**
 * WHILE TEX WAITS ON THE PERSON, ITS BROWSER WAITS TOO (Dev2, 2026-10-28).
 *
 * A Browserbase browser is released five minutes after its last use
 * (`infra/site-shots/src/idle.ts`). When a turn ends asking the person for
 * something only they can give — the code a site just sent them, a captcha, a
 * login to save in the vault — a reply after minute five used to find the
 * page gone, and Tex signed in again from the start. Such a turn now holds
 * the browser fifteen minutes (`/browse/hold`), so the reply lands on the same
 * page, still waiting for the code.
 *
 * Browserbase's own "pause and resume agent runs" does this for its hosted
 * agent; Tex drives its own browser, so the hold is ours (decided 2026-10-24,
 * `docs/decisions/texting-assistant/browser-hold.md`).
 */

/** Something only the person can hand over, in Tex's words. */
const THEIRS =
  /\b(?:codes?|passcodes?|pins?|captchas?|verification|verify|two-factor|2fa|one-time|otp|security (?:question|key)|authenticator|password|log ?in|sign(?:ed)? ?in|save (?:the |your |a )?login)\b/i;
/** A sentence that waits on their answer: a question, or an ask to text it back. */
const ASKS = /\?|\b(?:text|send|reply|tell|give|forward)\s+(?:me|it|that|them)\b|\blet me know\b|\bonce you(?:'ve| have)?\b|\bwhen you(?:'ve| have)?\b/i;

/** Whether a turn ends waiting on the person for something only they can give. */
export function waitsOnThem(answer, { vaultLink = false } = {}) {
  if (vaultLink === true) return true;
  const sentences = String(answer ?? "")
    .replace(/[‘’]/g, "'")
    .split(/\n+|(?<=[.!?])\s+/);
  // The ask may be the next sentence: "It just sent a code to your phone. What is it?"
  return sentences.some((sentence, i) => THEIRS.test(sentence) && (ASKS.test(sentence) || ASKS.test(sentences[i + 1] ?? "")));
}
