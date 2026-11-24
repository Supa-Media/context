/**
 * Finish the text node "finish" (`texConfig.json`; Dev2, 2026-11-23, the no-shadow steps): the gateway's own work on
 * the model's words after every check (`../../texEntryPoint/finishTheText.js`), before Text them delivers them. It runs
 * for a reply Text them builds (`sendTheReply.js`); a check-in's look, an answer a door step already made, and a
 * routine's run go through as they are, as Text them handles them (`send.js`).
 *
 * Its row in the chat's record carries counts and flags, never the words.
 */
import { finishTheText } from "../../texEntryPoint/finishTheText.js";

export async function finishNode(_input, io) {
  const t = io.ctx.turn;
  if (typeof t.finishCheckIn === "function" || t.drafts === undefined || t.response !== undefined || t.runner) return { when: ["as-is"] };
  t.finished = await finishTheText(t);
  return { when: ["finished"], chars: t.finished.sent.length, asked: t.ledger?.asked?.length ?? 0, silent: t.finished.silent === true };
}
