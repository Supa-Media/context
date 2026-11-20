/**
 * A TAPBACK AS THE WHOLE ANSWER (Dev2, 2026-11-17, picked "Front door picks the tapback" on "Should Tex be able to
 * answer with only a tapback, like 🗓 for 'add dinner Friday'?").
 *
 * Until now a turn of the front door could end only in words or in `say_nothing`; the only tapback it could give was
 * a started job's (`background.js` `QUIET_ACK`). A person who texts "add dinner Friday" and sees it added, or texts
 * "thanks!", is often answered best by one tapback on their text, the way a friend would. This is that ending: the
 * front door calls `send` with action `tapback` and an emoji, the Tapback node (`graph/nodes/tapback.js`) checks it,
 * and the turn ends with no text; the Worker reacts to their text with it (`packages/tex/worker/reactEmoji.ts` checks the
 * emoji again). When to use it is taught by examples, never a rule here (judgment by examples).
 *
 * Offered only while the config wires `tools -> tapback` (`texEntryPoint/runTheModel.js`; wired on main since the
 * Promote of 2026-11-17), on a chat turn that is not a job, a routine, a job's report or another chat's ask, and that
 * answers a text of theirs the Worker can react to (never their own tapback, a vault save or a hand-back).
 * Never beside words (Dev2, 2026-11-10): the call ends the turn, so nothing else is texted with it.
 */

import { REACT_EMOJI } from "../../src/textDecide.cjs";

export const TAPBACK_TOOL = "tapback";

/** The 64 emoji a tapback may be (`textDecide.cjs` `REACT_EMOJI`), by name and by the emoji itself. */
const EMOJI_BY_NAME = new Map(Object.entries(REACT_EMOJI).map(([name, { emoji }]) => [name, emoji]));
const EMOJI = new Set(EMOJI_BY_NAME.values());
const bare = (text) => text.replace(/️/g, "");
const EMOJI_BY_BARE = new Map([...EMOJI].map((emoji) => [bare(emoji), emoji]));

/** One of the 64, from the emoji (with or without its variation selector) or its name; null for anything else. */
export function tapbackEmoji(said) {
  if (typeof said !== "string") return null;
  const text = said.trim();
  if (text === "") return null;
  if (EMOJI.has(text)) return text;
  return EMOJI_BY_BARE.get(bare(text)) ?? EMOJI_BY_NAME.get(text.toLowerCase().replace(/[\s-]+/g, "_")) ?? null;
}

export const TAPBACK_DEFINITION = {
  name: TAPBACK_TOOL,
  description:
    "Answer their text with one tapback on it instead of words, and end your turn: nothing is texted. " +
    "Refused after a call that failed, and when they tagged you by name.",
  inputSchema: {
    type: "object",
    properties: {
      emoji: { type: "string", description: `The one emoji, from these only: ${[...EMOJI].join(" ")}` },
      why: { type: "string", description: "In a few words, why a tapback answers them. Kept in the history, never sent." },
    },
    required: ["emoji"],
  },
};

/** The answer a turn that ended in a tapback hands on, read back by `tapbackOf` (never texted: `sendTheReply.js`). */
const MARK = /^\[\[tex:tapback:([^\]\s]{1,8})\]\]$/u;
export const tapbackAnswer = (emoji) => `[[tex:tapback:${emoji}]]`;

/** The emoji a turn ended in, or null when it ended any other way: only a turn the tapback call settled (`turn.js` `settled`). */
export function tapbackOf(turn) {
  if (turn?.settled !== TAPBACK_TOOL) return null;
  const match = MARK.exec(String(turn.answer ?? ""));
  return match && EMOJI.has(match[1]) ? match[1] : null;
}

/** What the chat keeps as said, in place of a text (`ledgerConversation.js` reads it like any said line). */
export const tapbackSaidLine = (emoji) => `(You texted them nothing and reacted ${emoji} to their text.)`;

/**
 * Whether the last call this turn made before the tapback failed: then they are told in words, never with a tapback.
 * Only this turn's: the messages after their text (the last `user` one), never a call an earlier turn's history holds.
 */
export function lastCallFailed(messages) {
  const all = Array.isArray(messages) ? messages : [];
  const from = all.findLastIndex((message) => message?.role === "user") + 1;
  const calls = all.slice(from).filter((message) => message?.role === "tool");
  return calls.length > 0 && calls.at(-1).isError === true;
}

/**
 * The local tool and the `endsTurn` it settles with. `gate(input)` runs the Tapback node over the config's wire and
 * answers `{ to: "react", emoji }` or `{ to: "refuse", why }`; a refusal goes back to the model, which writes words.
 */
export function tapbackEnding({ gate, tagged = false }) {
  let chosen = null;
  const local = {
    tool: TAPBACK_DEFINITION,
    call: async (args = {}, turn = {}) => {
      const out = await gate({ emoji: typeof args.emoji === "string" ? args.emoji : "", why: typeof args.why === "string" ? args.why.slice(0, 300) : "", lastFailed: lastCallFailed(turn.messages), tagged: tagged === true }).catch(() => null);
      if (out?.to !== "react" || tapbackEmoji(out.emoji) === null) {
        const why = typeof out?.why === "string" && out.why ? out.why : "the tapback could not be checked";
        return { isError: true, content: [{ type: "text", text: `No tapback: ${why}. Write your reply in words.` }] };
      }
      chosen = tapbackEmoji(out.emoji);
      return { content: [{ type: "text", text: `They see ${chosen} on their text and nothing else, unless a call beside it failed. Your turn ends here.` }] };
    },
  };
  // A call beside it in the same round that failed after it (`turn.js` passes `roundFailed`): the turn goes on, in words.
  const endsTurn = (name, _args, round = {}) => (name === TAPBACK_TOOL && chosen !== null && round?.roundFailed !== true ? tapbackAnswer(chosen) : null);
  return { local, endsTurn };
}

/** Two `endsTurn`s as one: the first that settles the call wins. */
export function eitherEnds(first, second) {
  if (typeof first !== "function") return second ?? null;
  if (typeof second !== "function") return first;
  return (name, args, round) => first(name, args, round) ?? second(name, args, round);
}
