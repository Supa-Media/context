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
 *  - any other text reads no ask at all (owner, 2026-11-03: "get rid of the
 *    waiting asks step entirely"; listing them cost ~5 s a text). Only the
 *    Worker's fixed texts are kept in the history (`texEntryPoint/settleAYesOrNo.js` `keep_told`).
 * After the model, the reply checks don't run, and the chat is saved after the
 * reply has gone (`texEntryPoint.js`).
 *
 * A setup turns it off with `front_door: off` (`production.js`), and a
 * deployment with `TEX_FRONT_DOOR=off`; either brings back the old turn
 * exactly. A background job's turn keeps the reply checks: it is not a reply.
 */

import { approvalVerdict } from "./textedApprovals.js";

/** Whether this text could answer an ask Tex is holding: a yes or a no in words, or a tapback on one of its texts. */
export function mayAnswerAsk(question, quoted, hasAttachments) {
  if (quoted?.tapback) return true;
  return !hasAttachments && approvalVerdict(question) !== null;
}

/** `front_door:` in a setup: on unless it says off. `null` for anything else, which makes the setup invalid. */
export function readFrontDoor(value) {
  if (value === undefined || value === "on" || value === true) return true;
  if (value === "off" || value === false) return false;
  return null;
}
