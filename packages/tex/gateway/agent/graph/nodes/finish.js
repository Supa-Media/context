/**
 * Finish the text node "finish" (`texConfig.json`; Dev2, 2026-11-23, the no-shadow steps): the gateway's own work on
 * the model's words after every check (`../../texEntryPoint/finishTheText.js`), before Text them delivers them. It runs
 * for a reply Text them builds (`sendTheReply.js`); a check-in's look, an answer a door step already made, and a
 * routine's run go through as they are, as Text them handles them (`send.js`).
 *
 * Then, when its `finish -> nudgeOffer` wire's step is on, it asks the Nudge (`nudgeOffer.js`) whether one offer line
 * goes after the answer, and adds the line when the Nudge says it was sent (Dev and Seyi, 2026-11-24).
 *
 * Its row in the chat's record carries counts and flags, never the words.
 */
import { finishTheText } from "../../texEntryPoint/finishTheText.js";

/** The finished text with the nudge's line after the answer, before a browser hand-off link. */
export function withNudgeLine(finished, line) {
  const answer = `${finished.answer}\n\n${line}`;
  const sent = finished.sent.startsWith(finished.answer) ? `${answer}${finished.sent.slice(finished.answer.length)}` : `${finished.sent}\n\n${line}`;
  return { ...finished, answer, sent, nudgeLine: line };
}

export async function finishNode(_input, io) {
  const t = io.ctx.turn;
  if (typeof t.finishCheckIn === "function" || t.drafts === undefined || t.response !== undefined || t.runner) return { when: ["as-is"] };
  t.finished = await finishTheText(t);
  let nudged = false;
  if (typeof io.on === "function" && io.on("nudgeOffer") && io.use && "nudgeOffer" in io.use) {
    const said = await io.use.nudgeOffer({ chars: t.finished.answer.length }).catch(() => null);
    if (said?.to === "offer" && said.sent === true && typeof said.line === "string" && said.line !== "") {
      t.finished = withNudgeLine(t.finished, said.line);
      nudged = true;
    }
  }
  return { when: ["finished"], chars: t.finished.sent.length, asked: t.ledger?.asked?.length ?? 0, silent: t.finished.silent === true, ...(nudged ? { nudged: true } : {}) };
}
