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
 */

import { TRY_NOTICE, saysItCouldNot } from "./claimCheck.js";

/** `{ wrapWeb, check }`, shaped like `claimCheck`'s, for `runTurn`'s `web` and `answerCheck`. */
export function untriedWebCheck() {
  let hadWeb = false;
  let triedWeb = false;
  let noticed = false;
  return {
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
    check(answer) {
      if (noticed || !hadWeb || triedWeb || !saysItCouldNot(answer)) return null;
      noticed = true;
      return TRY_NOTICE;
    },
  };
}
