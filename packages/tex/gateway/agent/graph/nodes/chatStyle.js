/**
 * The chat style node: how the people in this chat text, counted from their recent texts (`../../chatStyle.js`), for
 * the front door's per-text facts. A wire from the front door (`fd -> chatStyle`, `uses`) turns it on; the front door
 * starts it at its first step, in a 1:1 and a group alike. The counts stay on the turn (`t.chatStyle`) and never ride on
 * this node's output, which the chat's log keeps: it says only how many texts and people were counted. It never throws.
 *
 * Input `{}`. Output `{ when: ["found"], texts, people }` or `{ when: ["none"], why }`.
 */
import { readChatStyle } from "../../chatStyle.js";
import { ledgerPlace } from "../../ledger.js";

export async function chatStyleNode(_input, io) {
  const t = io?.ctx?.turn ?? null;
  if (t === null) return { when: ["none"], why: "no turn" };
  const place = ledgerPlace(t.session);
  if (place === null || typeof t.store?.texLedger !== "function") return { when: ["none"], why: "no ledger" };
  try {
    const style = await readChatStyle(await t.store.texLedger(place.owner.chat ?? null), place.chat, { group: t.group !== null && t.group !== undefined });
    if (style === null) return { when: ["none"], why: "no texts" };
    t.chatStyle = style;
    return { when: ["found"], texts: style.room.texts, people: style.people ? Object.keys(style.people).length : 1 };
  } catch (error) {
    return { when: ["none"], why: `error:${typeof error?.name === "string" ? error.name : "error"}` };
  }
}
