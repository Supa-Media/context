/**
 * The chat style node: how the people in this chat text, counted from their recent texts (`../../chatStyle.js`) in the entries the turn's history read already holds, for
 * the front door's per-text facts. A wire from the front door (`fd -> chatStyle`, `uses`) turns it on; the front door
 * starts it at its first step, in a 1:1 and a group alike. The counts stay on the turn (`t.chatStyle`) and never ride on
 * this node's output, which the chat's log keeps: it says only how many texts and people were counted. It never throws.
 *
 * Input `{}`. Output `{ when: ["found"], texts, people }` or `{ when: ["none"], why }`.
 */
import { styleOfEntries } from "../../chatStyle.js";
import { ledgerPlace } from "../../ledger.js";

export async function chatStyleNode(_input, io) {
  const t = io?.ctx?.turn ?? null;
  if (t === null) return { when: ["none"], why: "no turn" };
  const place = ledgerPlace(t.session);
  if (place === null) return { when: ["none"], why: "no ledger" };
  try {
    // The entries the turn's history read already holds (`turnReads`): no read of its own.
    const read = t.historyRead ? await t.historyRead : null;
    const entries = Array.isArray(read) ? read[0]?.ledgerEntries ?? null : null;
    if (entries === null) return { when: ["none"], why: "no ledger" };
    const style = styleOfEntries(entries, place.chat, { group: t.group !== null && t.group !== undefined });
    if (style === null) return { when: ["none"], why: "no texts" };
    t.chatStyle = style;
    return { when: ["found"], texts: style.room.texts, people: style.people ? Object.keys(style.people).length : 1 };
  } catch (error) {
    return { when: ["none"], why: `error:${typeof error?.name === "string" ? error.name : "error"}` };
  }
}
