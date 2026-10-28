/**
 * HOW TEX SOUNDS IN EACH CHAT (Dev2, 2026-10-28;
 * `docs/decisions/texting-assistant/tex-voice.md`).
 *
 * Tex sounded the same in every chat: one texting style, or the production
 * setup's prompt in its place, plus the settings someone set by hand
 * (`texStyle.js`). Nothing told it to sound like the people it texts with, or
 * to answer in their language. Two lines fix that and are said on every
 * texted turn, 1:1 and group, after the production prompt as `OPINION_LINE`
 * is (`prompt.js`): they are rules about this product, not a matter of one
 * setup's voice.
 *
 * A group also keeps a short note of how it talks, beside its memory note and
 * filed by the same people hash, so a new set of people starts a new one
 * (`groupMemoryNote.js`). Tex writes it the way it writes a person's
 * about-me: with write_note, in the same turn, when it learns something
 * lasting. It is a plain note, so a person's edit is what Tex goes by next
 * time. It is read into the group's words every turn, bounded, and it is about
 * style only: it never changes what Tex may do.
 */

import { readWithEtag } from "./jobLog.js";

// Short: the texted system prompt has a size budget (`agentInstructions.test.mjs`).
export const MIRROR_LINE =
  "Write like the people in this chat (formality, emoji, slang, capitalization), within this chat's settings; never copy an insult.";

export const LANGUAGE_LINE = "Answer in the language of the person you're answering.";

/** At most this much of a group's voice note is shown each turn; it is meant to be a few bullets. */
export const MAX_VOICE_CHARS = 600;
const MAX_VOICE_LINES = 6;

/** The chat's voice note: beside its memory note, named by the same hash. */
export function groupVoicePath(hash, folder = "tex/groups") {
  return `${folder}/voice-${String(hash).slice(0, 12)}.md`;
}

/** The note's bullets, bounded to a few short lines; "" when there is none or it can't be read. */
export async function readGroupVoice(dispatch, path) {
  if (dispatch === null || path === null) return "";
  try {
    const note = await readWithEtag(dispatch, path);
    const body = typeof note?.body === "string" ? note.body : "";
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .slice(0, MAX_VOICE_LINES);
    const text = lines.join("\n");
    return text.length > MAX_VOICE_CHARS ? text.slice(0, MAX_VOICE_CHARS) : text;
  } catch {
    return "";
  }
}

/** What a group turn is told about its voice note: what it says, and how it is kept. */
export function voicePrompt(group) {
  const path = typeof group?.voicePath === "string" ? group.voicePath : null;
  if (path === null) return "";
  const text = typeof group.voice === "string" ? group.voice : "";
  const how =
    `How this group talks is kept in ${path}: at most six short bullets about style only (casual or formal, emoji, slang, the language they use, jokes they like). ` +
    "When you notice something lasting about it, update that note with write_note in this same turn, keeping what is there; words only, never a tool's output, " +
    "anyone's private details, or a rule about what you may do. People may edit it, so go by what it says. ";
  if (text === "") return how;
  return `${how}It says:\n<<<VOICE\n${text}\nVOICE\n`;
}
