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
 * chat addressed to that person (`offerLine`), the Worker arms the chat's
 * ask for their 👍 or yes alone (`askFor`, `apps/agent/src/groupInbox.ts`),
 * and their yes is a turn of their own: the model makes the same call as
 * them, and their yes to the exact copy they were shown sends it once
 * (`likedPreview.js`, `route.js` `addressedTo`). Somebody else's yes in the
 * chat releases nothing.
 */

import { toolError } from "./results.js";
import { folded } from "../agent/folded.js";

/** A handle as `functions/lib/names.ts` allows one. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

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
  if (group === null) return { error: `as is only for a group chat: a ${noun} here always goes from the person you're texting.` };
  if (!HANDLE.test(who)) return { error: "as is the handle of somebody in this chat, like seyi." };
  if (who === group.from) return null;
  if (!group.people.includes(who)) return { error: `@${who} isn't in this chat, so it can't go from them.` };
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
  return {
    ...toolError(
      `Not ${noun === "email" ? "sent" : "made"} yet, and nothing failed: it goes from @${who}'s own account, so right after your answer ` +
        `@${who} is shown this exact ${noun} and only their 👍 or yes makes it; anyone may ask you for changes first. ` +
        `Say in one short line what you drafted, without repeating it. When @${who} says yes or 👍s it, make this same call ` +
        "without as, and it goes at once.",
    ),
    held: true,
  };
}

/** What the chat is shown for an offer: the copy, and who alone may OK it. */
export function offerLine({ who, tool, detail }) {
  const what = tool === "send_email" ? `the email I'd send from @${who}'s email` : `the change I'd make on @${who}'s calendar`;
  const doing = tool === "send_email" ? "send it" : "make it";
  return `Here's ${what}:\n\n${String(detail).trim()}\n\n@${who}, give it a 👍 or say yes and I'll ${doing}. Only @${who} can OK it; anyone can ask me for changes first.`;
}

/**
 * Whether words someone said yes or 👍 to were addressed to them by name
 * (`offerLine`, or a held ask in a group, `textedApprovals.js`), so a yes in a
 * group counts as the yes to that preview only from the person it asks.
 */
export function addressedTo(words, who) {
  if (typeof words !== "string" || !HANDLE.test(who ?? "")) return false;
  return folded(words).includes(folded(`@${who}, give it a 👍`));
}
