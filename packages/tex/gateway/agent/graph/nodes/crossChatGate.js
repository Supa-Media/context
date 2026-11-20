/**
 * The Cross-chat gate, node `crossChatGate` (`texNodeShelf.json` until a Lab draft wires `tools -> crossChatGate`;
 * `../../crossChat.js`). Before an `ask_chat` leaves a chat, it says whether it may: who may ask whom, and the limits
 * (Dev2, 2026-11-17, design https://claude.ai/artifact/N3ZawPjhhgYcNfHm7xWa37, choices 1 and 4).
 *
 * - From a 1:1, only to a group of theirs (the tool resolved it from their own list); from a group, only to the
 *   personal Tex of whoever tagged it. Never group to group, never from a guest.
 * - One open ask per pair of chats; 10 an hour and 40 a day per chat. The counts are the asking chat's own, from the
 *   texting Worker that keeps its asks (`packages/tex/worker/crossChat.ts`).
 * - A run started by an ask never reaches here: it has no `ask_chat` (one hop).
 *
 * No model and no reads: pure code over what it is handed, logged like every node. Output `to`: "ask" with the ask the
 * Worker carries, or "refuse" with why, in words the model passes on.
 */
import { CROSS_CHAT_LIMITS, crossAskId } from "../../crossChat.js";

/** The key the Worker counts an open ask under: one per pair of chats. */
export function pairOf(to) {
  return to?.kind === "group" ? `group:${to.key}` : "person";
}

/** @param {{ from: "one" | "group", to: { kind: "group", key: string, name?: string } | { kind: "person", who: string }, what: string, do: boolean, guest: boolean, counts: { hour: number, day: number, open: string[] } }} input */
export async function crossChatGateNode(input) {
  const refuse = (why) => ({ to: "refuse", why });
  if (input.guest === true) return refuse("whoever tagged you isn't on Context, so they have no personal Tex to ask");
  if (input.from === "one" && input.to?.kind !== "group") return refuse("from a 1:1 you can ask only one of their group chats; name one of the group chats orient lists");
  if (input.from === "group" && input.to?.kind !== "person") return refuse("a group chat can ask only the personal Tex of whoever tagged it, never another group; ask the tagger's own Tex instead");
  if (input.to?.kind === "person" && !input.to.who) return refuse("there is nobody here with a personal Tex to ask");
  if (typeof input.what !== "string" || input.what.trim() === "") return refuse("there is no ask: pass what you want the other chat to know or do");
  const counts = input.counts ?? { hour: 0, day: 0, open: [] };
  const pair = pairOf(input.to);
  if ((counts.open ?? []).includes(pair)) return refuse("an ask to that chat is still waiting for its answer; its answer comes back as its own turn, so wait for it");
  if (counts.hour >= CROSS_CHAT_LIMITS.perHour) return refuse(`this chat has asked other chats ${CROSS_CHAT_LIMITS.perHour} times this hour, the most it may`);
  if (counts.day >= CROSS_CHAT_LIMITS.perDay) return refuse(`this chat has asked other chats ${CROSS_CHAT_LIMITS.perDay} times today, the most it may`);
  return { to: "ask", ask: { id: crossAskId(), pair, to: input.to, what: input.what.trim(), do: input.do === true } };
}
