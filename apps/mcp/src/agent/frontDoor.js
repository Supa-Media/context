/**
 * TEX'S FRONT DOOR (Seyi, 2026-10-31: "go", on the drawing at
 * `@supa projects/tex/front-door-plan.md`).
 *
 * The new architecture makes Haiku the front door: a text comes in, Haiku
 * answers, the reply goes out. What the old turn did around every text (the
 * reply checks and the hand-back judge, reading the waiting asks three to five
 * times, saving the chat before answering) made a one-to-one "hi Tex" take
 * about three minutes, 3.5 seconds of it the model.
 *
 * On the front door, before the model:
 *  - a text that could answer a waiting ask (a bare yes or no, or a tapback on
 *    one of Tex's texts) is matched in code, as before: an email, a calendar
 *    change a guest would see or a vault key's first use waits for the
 *    person's yes, checked by the gateway and never the model;
 *  - any other text lists the waiting asks once, so the model can be told
 *    they still wait (`setAsideLine`), and reads no record when none wait.
 * After the model, the reply checks don't run, and the chat is saved after the
 * reply has gone (`route.js`).
 *
 * A setup turns it off with `front_door: off` (`production.js`), and a
 * deployment with `TEX_FRONT_DOOR=off`; either brings back the old turn
 * exactly. A background job's turn keeps the reply checks: it is not a reply.
 */

import { disarmRecords, listPending } from "../tools/approvals.js";
import { askOvertaken } from "./askOvertaken.js";
import { appendTold, readTold } from "./conversation.js";
import { approvalVerdict } from "./textedApprovals.js";

/** Whether this text could answer an ask Tex is holding: a yes or a no in words, or a tapback on one of its texts. */
export function mayAnswerAsk(question, quoted, hasAttachments) {
  if (quoted?.tapback) return true;
  return !hasAttachments && approvalVerdict(question) !== null;
}

/**
 * Any other text, as `settleTextedText` treats one with no yes or no in it,
 * with the waiting asks listed once instead of three times: the Worker's fixed
 * texts go in the history, an ask Tex has since texted something else after is
 * dropped (`askOvertaken.js`), and the rest are what the model is told still
 * wait. `{ setAside }` or `{ dropped }` as `settleTextedText` returns them, or
 * null when none wait.
 */
export async function waitingAsks(store, session, { conversation = null, told, now }) {
  if (conversation !== null) await appendTold(store, conversation, readTold(told));
  const asked = await listPending(store, { userId: session.actorUserId, texting: true, now });
  if (asked.length === 0) return null;
  if (await askOvertaken(store, conversation, asked.map(({ record }) => record))) {
    const stuck = await disarmRecords(store, asked);
    console.log(JSON.stringify({ event: "ask_overtaken", asks: asked.length, stuck }));
    return { dropped: asked.map(({ record }) => ({ tool: record.tool, summary: record.summary })) };
  }
  return { setAside: asked.map(({ record }) => ({ id: record.id, tool: record.tool, summary: record.summary, args: record.args })) };
}

/** `front_door:` in a setup: on unless it says off. `null` for anything else, which makes the setup invalid. */
export function readFrontDoor(value) {
  if (value === undefined || value === "on" || value === true) return true;
  if (value === "off" || value === false) return false;
  return null;
}
