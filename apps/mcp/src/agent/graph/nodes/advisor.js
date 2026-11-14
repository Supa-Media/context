/**
 * Advisor node "advisor" (`texConfig.json`): the front door asked it through `ask_advisor` and its `uses` wire. Its
 * code is the tool `advisor.js` `advisorTools` made for this turn, handed the turn so far as it was asked. What it was
 * asked and what it answered are the call's tool entry (`ledger.js` `toolEntry`, its thinking beside it); its output
 * says how long the answer was.
 */
import { ADVISOR_TOOL } from "../../advisor.js";

export async function advisorNode(input, io) {
  const calls = io.ctx.turn.toolCalls;
  const held = calls.held.get(input.call);
  const result = await calls.local.get(ADVISOR_TOOL)(held.args, held.turnSoFar);
  held.result = result;
  return { failed: result?.isError === true, chars: typeof result === "string" ? result.length : typeof result?.text === "string" ? result.text.length : 0 };
}
