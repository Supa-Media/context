/**
 * NOT TRIED IS NOT "I CAN'T OPEN IT", ON THE FRONT DOOR TOO (the Tex Devs
 * group, 2026-11-03).
 *
 * Dev shared a claude.ai artifact and asked "thoughts?". Tex answered "I still
 * can't open that artifact … Paste the main points here" without one web call
 * in the turn; its thinking said "the earlier note said I couldn't open it".
 * Another assistant in the same chat read the link. The old turn's claim check
 * sends that answer back (`claimCheck.js` `TRY_NOTICE`), but Haiku's front door
 * runs no reply checks (`frontDoor.js`), so it went out.
 *
 * This is the one check the front door keeps: an answer saying it couldn't
 * open, read or reach something, in a turn that had the web and tried nothing
 * on it, gets one more round to try. It is a regex over the answer and a flag
 * on the web's calls, so a turn that tried, or never says it couldn't, pays
 * nothing. The rest of the claim check stays off the front door.
 *
 * Since 2026-11-15 it also runs the figure check over what the model saw
 * (`sourcedFigures.js` `seenFiguresNotice`), once a turn: the reply reviewer
 * no longer reads chat turns (Dev2), and "unsourced" was most of what it sent
 * back.
 */

import { TRY_NOTICE, saysItCouldNot } from "./claimCheck.js";
import { recordReadNotice } from "./recordRead.js";
import { seenFiguresNotice } from "./sourcedFigures.js";

/**
 * `{ wrap, wrapWeb, check }`, shaped like `claimCheck`'s, for the front door.
 * `question` is their ask, so a record ask with no read can be sent back (`recordRead.js`).
 */
export function untriedWebCheck({ question = "" } = {}) {
  let hadWeb = false;
  let triedWeb = false;
  let noticed = false;
  let figuresChecked = false;
  let recordNoticed = false;
  const steps = [];
  return {
    /** The turn's own tools, so a read is visible to the record check. */
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        steps.push({ name, ok: result?.isError !== true });
        return result;
      };
    },
    wrapWeb(web) {
      if (web === null || web === undefined) return null;
      hadWeb = true;
      return {
        ...web,
        call: (name, args) => {
          triedWeb = true;
          return web.call(name, args);
        },
      };
    },
    /** `context` is the turn so far (`turn.js`): `messages`, and `system`, the prompt the model answered with. */
    check(answer, context = {}) {
      if (!noticed && hadWeb && !triedWeb && saysItCouldNot(answer)) {
        noticed = true;
        return TRY_NOTICE;
      }
      // An ask to read a record, with no read this turn. An offer after a finished write is not caught here:
      // "Want me to book it?" after writing the options is the next step, and a phrase cannot tell that from an extra offer.
      if (!recordNoticed) {
        const notice = recordReadNotice(question, steps);
        if (notice !== null) {
          recordNoticed = true;
          return notice;
        }
      }
      if (figuresChecked) return null;
      figuresChecked = true;
      return seenFiguresNotice(answer, context ?? {}); // the prompt it answered with and the messages so far
    },
  };
}
