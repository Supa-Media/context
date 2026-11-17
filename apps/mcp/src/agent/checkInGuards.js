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
 *
 * And what a routine or a check-in texts (the owner, 2026-10-23: one morning
 * texted "I couldn't reliably see recent Context code changes; no status
 * update. SKIP", then a one-off reminder's own words, "Remind them to call
 * Apple about actually reviewing the Context app"):
 *
 *   3. A quiet answer that explains itself. SKIP anywhere it stands alone at
 *      the start or the end of the answer is quiet, whatever came before it.
 *   4. Instructions read back. An answer that opens "Remind them to", "Tell
 *      them", "Text the person that" is the routine's note, not a text to
 *      them, and is turned into one: "Reminder: call Apple ...".
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

/** The word an answer with nothing to say is. */
export const QUIET_WORD = "SKIP";

/**
 * Whether an answer means "nothing to text": SKIP on its own (any case), or
 * an upper-case SKIP that opens or closes it, as when a model explains why it
 * is quiet and then says so. A text that only uses the word ("Skip the
 * meeting today") is still a text.
 */
export function saysQuiet(text) {
  const said = String(text ?? "").trim();
  if (said === "" || said.replace(/[.!]$/, "").toUpperCase() === QUIET_WORD) return true;
  return /^SKIP\b/.test(said) || /(?:^|[\s.;:,!—-])SKIP[.!]?$/.test(said);
}

const THEM = "(?:them|him|her|the (?:person|user))";
const INSTRUCTION_LEAD = new RegExp(
  `^(?:please\\s+)?(?:(remind)\\s+(?:${THEM}|me)|(?:tell|text|message|ping)\\s+${THEM}|let\\s+${THEM}\\s+know)\\s*(?:,|:|\\bto\\s+|\\bthat\\s+|\\babout\\s+|\\bof\\s+)?\\s*`,
  "i",
);

/**
 * The answer as a text to them: a routine's instructions read back ("Remind
 * them to call Apple") become the reminder itself ("Reminder: call Apple").
 * Leaves anything else exactly as it was.
 */
export function spokenToThem(text) {
  const said = String(text ?? "").trim();
  const lead = INSTRUCTION_LEAD.exec(said);
  if (lead === null) return said;
  const rest = said.slice(lead[0].length).trim();
  if (rest === "") return said;
  if (lead[1] !== undefined) return `Reminder: ${rest}`;
  return rest[0].toUpperCase() + rest.slice(1);
}
