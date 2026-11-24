/**
 * The member cards node: the cards of the people in a group chat's room, for the front door (`../../memberCards.js`;
 * `docs/decisions/texting-assistant/member-cards.md`). A wire from the front door (`fd -> memberCards`, `uses`) turns it
 * on; the front door starts it at its first step, on a group's turn only. The cards' words stay on the turn
 * (`t.memberCards`) for the front door's prompt and never ride on this node's output, which the chat's log keeps: it
 * says only how many people were named and how many had a card. It never throws.
 *
 * Input `{}`. Output `{ when: ["found"], asked, read }` or `{ when: ["none"], why }`.
 */
import { readMemberCards } from "../../memberCards.js";

export async function memberCardsNode(_input, io) {
  const t = io?.ctx?.turn ?? null;
  if (t === null || t.group === null || t.group === undefined) return { when: ["none"], why: "not a group" };
  try {
    const read = await readMemberCards({ env: t.env, controlPlane: t.controlPlane, session: t.session, group: t.group });
    if (read === null) return { when: ["none"], why: "not allowed" };
    t.memberCards = read;
    return { when: [read.cards.length > 0 ? "found" : "none"], asked: read.asked, read: read.cards.length };
  } catch (error) {
    return { when: ["none"], why: `error:${typeof error?.name === "string" ? error.name : "error"}` };
  }
}
