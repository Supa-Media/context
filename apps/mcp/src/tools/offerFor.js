/**
 * AN EMAIL OR A CALENDAR CHANGE OFFERED FOR SOMEBODY ELSE IN A GROUP CHAT
 * (the owner, 2026-10-24). People in a group ask Tex to send an email or
 * make an event, and refine it together, but it has to go from one person's
 * own account, and only that person may OK it: "the explicit thumbs up or yes
 * has to come from the person that the email is going to come from".
 *
 * Whoever tagged Tex is the sender by default, as before (`emailGate.js`
 * holds it for their yes). When someone else in the chat is to send it,
 * `as` names them: nothing is held, because a hold is the tagger's own and
 * their grant can't act for anyone else. Instead the copy is shown in the
 * chat in Tex's own words, put to that person by name, the Worker arms the chat's
 * ask for their 👍 or yes alone (`askFor`, `packages/tex/worker/groupInbox.ts`),
 * and their yes is a turn of their own: the model makes the same call as
 * them, and their yes to the exact copy they were shown sends it once
 * (`likedPreview.js`, `route.js` `addressedTo`). Somebody else's yes in the
 * chat releases nothing.
 */

import { toolError } from "./results.js";
import { heldFacts } from "./heldFacts.js";
import { HANDLE, addressedTo } from "../../../../packages/shared/src/toolContract.cjs";

const handleOf = (value) => (typeof value === "string" ? value.trim().replace(/^@/, "").toLowerCase() : "");

/**
 * Who a held call's `as` names, apart from the tagger: `null` when the call
 * is the tagger's own (no `as`, or `as` is them), `{ who }` for somebody else
 * in this chat, or `{ error }`.
 */
export function offerTarget(session, supplied, noun) {
  if (supplied?.as === undefined) return null;
  const group = session?.egress?.group ?? null;
  const who = handleOf(supplied.as);
  if (group === null) return { error: `as is only for a group chat: a ${noun} here always goes from the person you're texting. Call it again without as.` };
  if (!HANDLE.test(who)) return { error: "as is the handle of somebody in this chat: call it again with as like seyi, or leave it out." };
  if (who === group.from) return null;
  if (!group.people.includes(who)) return { error: `@${who} isn't in this chat, so it can't go from them: leave as out, or name somebody here.` };
  return { who };
}

/** The call without `as`, as the person it goes from makes it on their own turn. */
export function withoutAs(supplied) {
  const { as: _as, ...rest } = supplied ?? {};
  return rest;
}

/** Offer one call to `who`: kept for the end of the answer, never held. One per turn, and not beside a held one. */
export function offerFor(session, { who, tool, detail, noun }) {
  const ledger = session.egress?.ledger ?? null;
  if (ledger === null) return toolError(`Not done: a ${noun} for somebody else is offered in a group chat only.`);
  if (ledger.offered) {
    return toolError(`Not offered: this answer already offers one thing to @${ledger.offered.who}. Offer this after they answer.`);
  }
  if (ledger.asked.length > 0) return toolError("Not offered: this answer already asks for a yes. Offer this after it is answered.");
  ledger.offered = { who, tool, detail };
  // The facts: it goes from @who's own account, on their 👍 or yes alone, as this copy. Tex writes the offer, and the
  // copy goes whole in it (`finishTheText.js`); their yes is a turn of their own, where the same call without `as` goes.
  return heldFacts({ copy: detail, okFrom: who, account: who });
}

export { addressedTo };
