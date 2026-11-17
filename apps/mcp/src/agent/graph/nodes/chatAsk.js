/**
 * Another chat asks, node `chatAsk`, an input (`texNodeShelf.json` until a Lab draft wires it; `../../crossChat.js`).
 * The texting Worker starts a run in this chat for another chat's ask (kind "ask"), or for the answer to an ask this
 * chat sent (kind "answer"): a new run, never part of the one that asked (Dev2's generators model, 2026-11-16).
 *
 * It reads the Worker's event strictly and gives the run its fixed question (the gateway's own line, never the
 * other chat's words as theirs) and what the run is told. No model and no reads; logged like every node.
 */
import { crossChatOf, crossChatPrompt, crossChatQuestion } from "../../crossChat.js";

/** @param {{ event: string, crossChat: object, group: boolean }} input */
export async function chatAskNode(input) {
  const event = crossChatOf({ event: input.event, crossChat: input.crossChat }, { chatTurn: true, job: null });
  if (event === null) return { to: "refuse", why: "the ask could not be read" };
  return { to: event.kind, event, question: crossChatQuestion(event), prompt: crossChatPrompt(event, { group: input.group ? {} : null }) };
}
