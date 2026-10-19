/**
 * Tapbacks: a heart, a thumbs up, a question mark on one of Tex's texts.
 *
 * Every tapback was dropped (`ignored: reaction`), so a 👍 on "Want me to
 * book it?" went nowhere, and a ❓ on a muddled answer got no better one
 * (Tex's runtime redesign, 2026-10-19). Now:
 *
 * - a tapback that answers something is answered: a ❓ on any text, or a
 *   like, love, dislike or emphasis on a text that asked a question. It is
 *   queued like a text, with the words it was on sent apart as somebody
 *   else's (`apps/mcp/src/agent/quoted.js`), and its own text is the emoji;
 * - any other tapback is noted, not answered, and the next text the person
 *   sends carries the note to the turn, so "that one" can mean the text they
 *   just loved.
 *
 * Messages sends a tapback as words ("Loved “…”"), so the words it was on are
 * all there is, never a handle. A removed tapback is dropped as before.
 *
 * What it keeps: `reactions` holds at most five noted tapbacks, each with up
 * to 500 characters of the text it was on (Tex's own text, nearly always),
 * for at most a day, and is cleared as soon as a turn has been told them.
 */

import type { InboxStorage } from "./inbox";

export const REACTIONS_KEY = "reactions";
export const MAX_REACTIONS = 5;
export const REACTIONS_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_WORDS = 500;

/** A tapback by its English name, as the gateway reads it. */
export type Tapback = "Loved" | "Liked" | "Disliked" | "Laughed at" | "Emphasized" | "Questioned" | "Reacted";
export type Reaction = { how: Tapback; words: string };
type Kept = Reaction & { at: number };

const NAMES: [RegExp, Tapback][] = [
  [/^(?:Loved|Le encantó)$/u, "Loved"],
  [/^(?:Liked|Le gustó)$/u, "Liked"],
  [/^(?:Disliked|No le gustó)$/u, "Disliked"],
  [/^Laughed at$/u, "Laughed at"],
  [/^Emphasi[sz]ed$/u, "Emphasized"],
  [/^Questioned$/u, "Questioned"],
  [/^Reacted .{1,16} to$/u, "Reacted"],
];

const EMOJI: Record<Tapback, string> = {
  Loved: "❤️",
  Liked: "👍",
  Disliked: "👎",
  "Laughed at": "😂",
  Emphasized: "‼️",
  Questioned: "❓",
  Reacted: "👍",
};

const TAPBACK = /^(.{1,40}?) [“"]([\s\S]*)[”"]$/u;

/** A tapback's name and the words it was on; null for a removed one or anything else. */
export function readTapback(text: string): Reaction | null {
  const match = TAPBACK.exec(text.trim());
  if (match === null || /^Removed /u.test(match[1])) return null;
  const how = NAMES.find(([pattern]) => pattern.test(match[1]))?.[1];
  const words = match[2].trim().slice(0, MAX_WORDS);
  return how === undefined || words === "" ? null : { how, words };
}

/** Whether a tapback is answered: a question mark on anything, or a yes or no on a question. */
export function answers({ how, words }: Reaction): boolean {
  if (how === "Questioned") return true;
  return (how === "Liked" || how === "Loved" || how === "Emphasized" || how === "Disliked") && /\?\s*…?$/u.test(words);
}

/** The text an answered tapback is queued as. */
export function tapbackText(how: Tapback): string {
  return EMOJI[how];
}

/** Note a tapback that is not answered, for the next turn. Best effort: never throws. */
export async function noteReaction(storage: InboxStorage, reaction: Reaction, now: number): Promise<void> {
  try {
    const kept = (await storage.get<Kept[]>(REACTIONS_KEY)) ?? [];
    const fresh = kept.filter((item) => now - item.at < REACTIONS_FOR_MS);
    await storage.put<Kept[]>(REACTIONS_KEY, [...fresh, { ...reaction, at: now }].slice(-MAX_REACTIONS));
  } catch {
    // A tapback not noted costs the next turn a line, never the text.
  }
}

/** The noted tapbacks still fresh, oldest first. */
export async function notedReactions(storage: InboxStorage, now: number): Promise<Reaction[]> {
  const kept = (await storage.get<Kept[]>(REACTIONS_KEY)) ?? [];
  return kept.filter((item) => now - item.at < REACTIONS_FOR_MS).map(({ how, words }) => ({ how, words }));
}

/** Forget the tapbacks a turn was told. A tapback noted while it ran is kept. */
export async function clearReactions(storage: InboxStorage, told: Reaction[]): Promise<void> {
  if (told.length === 0) return;
  const kept = (await storage.get<Kept[]>(REACTIONS_KEY)) ?? [];
  const left = kept.filter((item) => !told.some((done) => done.how === item.how && done.words === item.words));
  if (left.length === 0) await storage.delete(REACTIONS_KEY);
  else await storage.put<Kept[]>(REACTIONS_KEY, left);
}
