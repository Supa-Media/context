/**
 * WHAT A CHECK-IN MAY NOT TEXT, DECIDED BY THE GATEWAY AFTER THE MODEL ANSWERS
 * (the owner, 2026-10-21).
 *
 * That morning a check-in texted the owner about a failed deploy from a GitHub
 * notification email, they answered "never message me about github stuff
 * unless i ask", and the next check-in opened "? No. This is a new thread,
 * not a follow-up. Here's the text:" before its news. A check-in runs on a
 * small model; what the person asked for and what reaches their phone are
 * not left to it:
 *
 *   1. Muted words. `mute:` in the front matter of `tex/heartbeat.md` or of
 *      `tex/attention.md` (where a texted "stop texting me about X" is kept,
 *      `checkIns.js`) silences any check-in that says one of them, matched as
 *      whole words like an agent's ping is (`attention.js` `mutedWord`). The
 *      model is told the words too, so it mostly stays quiet on its own.
 *   2. Talk about the check-in itself. A first paragraph that speaks of a
 *      new thread, "not a follow-up" or the `[continues N]` marker, or a
 *      lead-in like "Here's the text:", is the model talking to us, never
 *      to them, and comes off.
 */

import { mutedWord, readAttentionSettings } from "./attention.js";

/** The words they muted, from `tex/heartbeat.md` and `tex/attention.md`, each once. */
export function checkInMutes(...settingsTexts) {
  const words = new Set();
  for (const text of settingsTexts) for (const word of readAttentionSettings(text).mute) words.add(word);
  return [...words];
}

/** The muted word a check-in's text says, or null. */
export function mutedCheckIn(text, mutes) {
  return mutes.length === 0 ? null : mutedWord({ mute: mutes }, text);
}

const ABOUT_ITSELF = /(?:\bnew thread\b|\bthis thread\b|\bnot a follow-?up\b|\bthe marker\b|\[continues)/i;
const INTRODUCES = /\b(?:here(?:'|\u2019)?s|here is|below is)\s+(?:the|my|your)\s+(?:text|message|check-?in)\s*:\s*/i;

/**
 * The text with any words about the check-in itself taken off its front.
 * Leaves an ordinary text exactly as it was.
 */
export function withoutPreamble(text) {
  let said = String(text ?? "").replace(/^\s*\[\s*continues[^\]]*\]\s*/i, "");
  const paragraphs = said.split(/\n\s*\n/);
  if (paragraphs.length > 1 && (ABOUT_ITSELF.test(paragraphs[0]) || INTRODUCES.test(paragraphs[0]))) said = paragraphs.slice(1).join("\n\n");
  const introduced = INTRODUCES.exec(said);
  if (introduced !== null && introduced.index < 240) said = said.slice(introduced.index + introduced[0].length);
  return said.trim();
}
