/** A texted yes or no settles a waiting approval before any model runs; otherwise lists the approvals still open. One step of Tex's turn (`../texTurn.js`). */

import { json } from "../../http/responses.js";
import { SCOPE_WRITE, hasScope } from "../../session.js";
import { conversationPath } from "../conversation.js";
import { deferred } from "../deferred.js";
import { mayAnswerAsk, waitingAsks } from "../frontDoor.js";
import { keepGroupSettled, withoutTexName } from "../groupTurn.js";
import { readTimeZone } from "../localNow.js";
import { thumbsDownIsNo, thumbsUpIsYes } from "../textedApprovals.js";
import { settleTextedText } from "../textedSettle.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { chatLedger } from "../workEntries.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texEntryPoint.js`, checked by `scripts/tex-entry-check.mjs`)
export async function settleAYesOrNo(t) {
  const { body, dispatch, env, group, hot, job, outcome, question, quoted, received, sent, session, setupRead, store, tex } = t;
  // A texted yes or no settles a pending approval before any model runs (`textedSettle.js`).
  let setAside = [], dropped = [], paid = [], thumbsUp = false; // dropped: asks Tex texted something else after by itself (`askOvertaken.js`)
  // A group chat's yes is its tagger's, said to Tex in the chat (`groupTurn.js`); a guest's is nobody's (`groupGuests.js`).
  const front = env.TEX_FRONT_DOOR !== "off" && (await tex.wait("setup", setupRead))?.frontDoor !== false; // Haiku as the front door (`frontDoor.js`): only a yes or no is matched before it, and no reply checks after
  const ownConversation = group === null && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE) ? body.conversation : null, askChat = group?.key ?? null; // an ask, and the yes to it, belong to the chat it was made in (`approvals.js` `chatOfAsk`)
  if (store.ledger === null && ownConversation !== null) store.ledger = chatLedger(store, session); // any caller that keeps the person's texts keeps them in their chat's one record (`ledgerConversation.js`)
  if (front && (session.actorClientId === TEXTS_CLIENT_ID || group !== null) && job === null && group?.guestTagger !== true && !mayAnswerAsk(group !== null ? withoutTexName(question) : question, quoted, sent.length > 0)) ({ setAside = [], dropped = [] } = (await tex.step("waiting_asks", () => waitingAsks(store, session, { conversation: ownConversation, told: body.told, now: received, chat: askChat }), null)) ?? {});
  else if ((session.actorClientId === TEXTS_CLIENT_ID || group !== null) && job === null && group?.guestTagger !== true) {
    thumbsUp = await tex.step("thumbs_up", () => thumbsUpIsYes(store, session, quoted, { who: group?.from || null, chat: askChat })); // a 👍 on the ask is that yes
    const thumbsDown = !thumbsUp && (await tex.step("thumbs_down", () => thumbsDownIsNo(store, session, quoted, { who: group?.from || null, chat: askChat }))); // and a 👎 the no
    const settled = await tex.step("settle_yes", () => settleTextedText(store, session, {
      dispatch,
      // A tapback's own text is its emoji: a 👍 on other words is not a typed 👍, so it is no verdict.
      question: thumbsUp ? "yes" : thumbsDown ? "no" : quoted.tapback ? "" : group !== null ? withoutTexName(question) : question,
      keep: group !== null ? keepGroupSettled(store, group, dispatch) : null,
      hasAttachments: sent.length > 0,
      now: received,
      timeZone: readTimeZone(body.timeZone),
      defer: (work) => deferred(store, work),
      // Kept on the same terms as a model turn's history, below, with the Worker's fixed texts (`told`).
      conversation: ownConversation,
      told: body.told,
      thumbsUp, chat: askChat,
    }));
    if (settled?.answer !== undefined) return (outcome.clean = true), json({ ...settled, warm: (await tex.step("seal_warm", () => hot.seal({ wrote: true }))) ?? undefined }); // the gateway's words, nothing read; its yes goes in the copy too
    ({ setAside = [], dropped = [] } = settled ?? {});
    paid = settled?.allowed ?? [];
  }
  Object.assign(t, { askChat, dropped, front, ownConversation, paid, setAside, thumbsUp });
}
// TEX ENTRY POINT: end
