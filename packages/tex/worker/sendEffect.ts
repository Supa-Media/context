/**
 * Tex's own iMessage effects (Dev, 2026-11-23: "... and effects seem like features id like to use"; design
 * `@supa projects/tex-imessage-line/photon-sending-design.md`). Tex reads a received effect as "(sent with Slam)"
 * before the words (`photonRich.ts`), and writes one the same way: a text of Tex's that starts "(sent with Invisible
 * Ink)" goes on Photon's line with that effect and without those words. Any other line has no effects, so there the
 * words go without the mark.
 *
 * Pure: no fetch, no storage.
 */

import { withoutPollMark } from "./sendPoll";

/** The effects Tex may send, by the name Messages shows, to the bridge's name for each (`validate.mjs` `EFFECT_NAMES`). */
const SENDABLE: Readonly<Record<string, string>> = Object.freeze({
  slam: "slam",
  loud: "loud",
  gentle: "gentle",
  "invisible ink": "invisible",
  confetti: "confetti",
  fireworks: "fireworks",
  balloons: "balloons",
  love: "heart",
  lasers: "lasers",
  spotlight: "spotlight",
  echo: "echo",
});

/** Names Messages gives that Tex reads but does not send (no single bridge name): the mark is still taken off. */
const READ_ONLY = new Set(["celebration", "shooting star", "an effect"]);

const LEAD = /^\s*\(sent with ([A-Za-z ]{2,20})\)[ \t]*/i;

/** A text's words without a leading "(sent with X)", and the bridge's name for X when it is one Tex can send. */
export function effectOf(text: string): { text: string; effect?: string; mark: number } {
  const match = LEAD.exec(text);
  if (match === null) return { text, mark: 0 };
  const name = match[1]!.trim().toLowerCase();
  const effect = SENDABLE[name];
  if (effect === undefined && !READ_ONLY.has(name)) return { text, mark: 0 };
  const rest = text.slice(match[0].length);
  // A mark with no words after it is not a text with an effect: the words go as written.
  if (rest.trim() === "") return { text, mark: 0 };
  return { text: rest, mark: match[0].length, ...(effect !== undefined ? { effect } : {}) };
}

/** A line that has no effects or polls: each text goes without its "(sent with X)" or "(poll)" mark (`sendPoll.ts`). */
export function withoutEffects<L extends { sendText(where: never, text: string, ...rest: never[]): Promise<string | undefined> }>(line: L): L {
  const sendText = line.sendText.bind(line) as (...args: unknown[]) => Promise<string | undefined>;
  return {
    ...line,
    sendText: async (...args: unknown[]) => {
      const words = effectOf(String(args[1] ?? ""));
      return await sendText(args[0], withoutPollMark(words.text), ...args.slice(2));
    },
  } as L;
}
