/**
 * Tex added, node `joined`, an input (`texNodeShelf.json` until a Lab draft wires it; the Worker's half is
 * `packages/tex/worker/groupJoined.ts`). Dev2, 2026-11-25: "Tex should have an intro when added to a group".
 *
 * The texting Worker starts one run in a group the moment Tex is new to it: its own number added there, or the
 * group's first message ever. The run names only the event; this node gives it its fixed line (the gateway's own
 * words, never the Worker's) and the Front door writes the hello. A run that is not a group's is refused: Tex is never
 * "added" to a 1:1. No model and no reads; logged like every node.
 */
import { JOINED_EVENT, joinedQuestion } from "../../joined.js";

/** @param {{ event: string, group: boolean }} input */
export async function joinedNode(input) {
  if (input?.event !== JOINED_EVENT) return { to: "refuse", why: "not a join" };
  if (input.group !== true) return { to: "refuse", why: "only a group chat adds Tex" };
  return { to: "intro", question: joinedQuestion() };
}
