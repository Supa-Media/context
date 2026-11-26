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
 *
 * On 2026-11-19 a console 1:1 said "I already did this at 1:31 PM … The reply
 * is saved as a Gmail draft" with no call in the turn, and the draft was
 * gone. That check (`standsCheck.js` `standsGate`) moved out of here the same
 * day: it missed every turn this file does not check, so it is now composed
 * into every chat turn's answer checks (`runTheModel.js`).
 * `frontDoorChecks` picks which of these runs for a turn.
 *
 * Since 2026-11-24 it also sends back an answer saying an email was sent when
 * no send_email went through this turn (`claimCheck.js` rule 7, `SENT_NOTICE`):
 * a Mail checker "no" had been refused with nothing held, the 👍 on Tex's own
 * question matched no ask, and front-door texts run no other claim check.
 *
 * Since 2026-11-26 it also sends back an answer that asks for a yes or 👍 to an email, a message or a report it names, in
 * its own words, when nothing was held this turn and it isn't pointing at an ask already waiting (`claimCheck.js` `offersAHeldChange`, `offerNotice`): in a
 * group chat with a shared mailbox, Tex wrote a reply out and asked its person to "text me yourself with a yes", so a
 * yes would have sent nothing, and only the claim check, which front-door texts don't run, knew to send it back.
 */

import { SENT_NOTICE, TRY_NOTICE, falselySent, namedOfferKinds, offerNotice, offersAHeldChange, saysItCouldNot, sentBy } from "./claimCheck.js";
import { EMPTY_NOTICE, isEmptyAnswer, pointsAtWaitingAsk } from "./replyChecks.js";
import { recordReadNotice } from "./recordRead.js";
import { seenFiguresNotice } from "./sourcedFigures.js";
import { stepOf } from "./standsCheck.js";

/**
 * `{ wrap, wrapWeb, check }`, shaped like `claimCheck`'s, for the front door.
 * `question` is their ask, so a record ask with no read can be sent back (`recordRead.js`).
 */
export function untriedWebCheck({ question = "", reaction = false, reported = false } = {}) {
  let hadWeb = false;
  let triedWeb = false;
  let noticed = false;
  let figuresChecked = false;
  let recordNoticed = false;
  let emptyNoticed = false;
  let sentNoticed = false;
  let offerNoticed = false;
  // Whether a call this turn was held for somebody's yes: a yes asked for then has something to send.
  let held = false;
  // What this turn's sends that went were: an email, or a Slack or Chat message (`sentBy`).
  const sent = new Set();
  const steps = [];
  return {
    /** The turn's own tools, so a read is visible to the record check, and a send to the sent check. */
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        steps.push(stepOf(name, args, result));
        if (result?.held === true) held = true;
        const went = sentBy(name, args, result);
        if (went !== null) sent.add(went);
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
      // An empty answer gets one more round on the front door too (Dev2, 2026-11-23: three refused sends ended in an empty
      // answer, and with no round to answer in, the fallback line went instead), as `claimCheck.js` gives every other turn.
      // Their own tapback may be answered with nothing at all: that quiet is never sent back.
      if (!emptyNoticed && !reaction && isEmptyAnswer(answer)) {
        emptyNoticed = true;
        return EMPTY_NOTICE;
      }
      // "Sent!" with no email sent this turn: one held for their 👍, or one that failed, has not gone.
      // A job's report relayed tells what the job sent (`reported`).
      if (!sentNoticed && !reported && falselySent(answer, { sent: sent.has("email"), sentOther: sent.has("other") })) {
        sentNoticed = true;
        return SENT_NOTICE;
      }
      // A yes or 👍 asked for in its own words to an email, a message or a report it names, with nothing held: the yes
      // would reach nothing. Never a calendar: a change to their own needs no yes, and sharing one here is asked in words,
      // their yes judged on the next text. Not after a refused call either: what to ask for is then that call's to say.
      const offered = offerNoticed || reaction || reported || held || steps.some((step) => !step.ok) ? [] : namedOfferKinds(answer).filter((entry) => entry.tool !== "calendar_event");
      // "It's still waiting for your 👍 above" points at an ask an earlier text holds: nothing new to make.
      if (offered.length > 0 && offersAHeldChange(answer) && !pointsAtWaitingAsk(answer, true)) {
        offerNoticed = true;
        return offerNotice(offered);
      }
      if (!noticed && hadWeb && !triedWeb && saysItCouldNot(answer)) {
        noticed = true;
        return TRY_NOTICE;
      }
      // A claim that something is already done or still in place is the stands gate's, which every chat turn runs (`standsCheck.js` `standsGate`, `runTheModel.js`).
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

/**
 * The one check a texted or group turn gets from its front-door side (`prepareTheAnswer.js`), or null. A console 1:1
 * gets none from here: the stands gate every chat turn runs is its check (`standsCheck.js` `standsGate`).
 */
export function frontDoorChecks({ claims, runner, texted, group, question, reaction = false, reported = false }) {
  if (claims === null && !runner && (texted || group !== null)) return untriedWebCheck({ question, reaction, reported });
  return null;
}
