/**
 * Tex did, node `did`, an input (`texNodeShelf.json` until a Lab draft wires it; the Worker's half is
 * `packages/tex/worker/didFacts.ts`). Dev2, 2026-11-25: code hands Tex facts and never writes what Tex says.
 *
 * Code ran something a person in this chat asked for, and the texting Worker started a run of the chat's own with what
 * happened. This node checks the facts and hands the Front door them as data (`../../did.js`); a run with no facts it
 * can read is refused, and says nothing. No model and no reads; logged like every node.
 */
import { DID_EVENT, didFactsOf, didQuestion } from "../../did.js";

/** @param {{ event: string, did: unknown }} input */
export async function didNode(input) {
  if (input?.event !== DID_EVENT) return { to: "refuse", why: "not a did event" };
  const facts = didFactsOf(input.did);
  if (facts === null) return { to: "refuse", why: "facts unreadable" };
  return { to: "tell", question: didQuestion(facts) };
}
