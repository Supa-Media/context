/**
 * The suggested emoji by meaning: every standard emoji has a short written
 * description, each description has a meaning fingerprint made once, and a
 * folder or note name's fingerprint picks the emoji whose fingerprint sits
 * closest. One embedding call per suggestion instead of two Clef questions
 * (the owner asked for speed, 2026-10-14).
 *
 * The fingerprints are the same for everybody, because everybody has the same
 * emoji: they are ours, built from this file, never from anyone's notes. Only
 * the name being suggested for is sent to the model, as `iconSuggest.ts`
 * already sends it to Clef.
 *
 * `emojiMeaningSet()` names one build of the fingerprints: the model and a
 * hash of every text. Changing a description, the table or the model gives a
 * new set, and the control plane fills the new set before reading it, so a
 * search never mixes fingerprints of two different texts.
 */

import { EMOJI_ABOUT_TABLE } from "./emojiAbout.generated";
import { nameWords } from "./iconSuggest";
import { STANDARD_EMOJI_TABLE } from "./standardEmoji.generated";

/** The fingerprint model. Must match `apps/mcp/src/search/meaning/embed.js`. */
export const EMOJI_MEANING_MODEL = "@cf/baai/bge-m3";

export interface EmojiMeaningText {
  char: string;
  /** What is fingerprinted: the emoji's official name and its description. */
  text: string;
}

let texts: EmojiMeaningText[] | null = null;

/** Every standard emoji with the text its fingerprint is made from, in the table's order. */
export function emojiMeaningTexts(): readonly EmojiMeaningText[] {
  if (texts !== null) return texts;
  const about = new Map<string, string>();
  for (const line of EMOJI_ABOUT_TABLE.split("\n")) {
    const [char, description] = line.split("\t");
    if (char && description) about.set(char, description);
  }
  texts = [];
  for (const line of STANDARD_EMOJI_TABLE.split("\n")) {
    const [char, , tags, name] = line.split("\t");
    if (!char || !name) continue;
    const description = about.get(char) ?? (tags ? `${name}; ${tags}` : name);
    texts.push({ char, text: `${name}: ${description}` });
  }
  return texts;
}

/** FNV-1a over the model and every text, as eight hex digits. Not security: a change detector. */
function fingerprintOf(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let at = 0; at < part.length; at += 1) {
      hash ^= part.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

let set: string | null = null;

/** The name of this build of the fingerprints. */
export function emojiMeaningSet(): string {
  if (set !== null) return set;
  const all = emojiMeaningTexts();
  set = `bge-m3-${all.length}-${fingerprintOf([EMOJI_MEANING_MODEL, ...all.map(({ char, text }) => `${char}\t${text}`)])}`;
  return set;
}

/** What is fingerprinted for a name: its words alone, as a person would search for them. */
export function nameMeaningText(path: string): string {
  return nameWords(path);
}
