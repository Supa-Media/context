/**
 * Tools node "tools" (`texConfig.json`): one tool call the front door made through its `uses` wire. Its code is the
 * dispatcher the front door was handed (`callToolForSession` behind every wrapper of `runTheModel.js`), the browser's
 * own (`computer.js`), or a tool answered in the turn itself (`turn.js` local tools), kept in `t.toolCalls`.
 *
 * The wire carries the call's number and the tool's name; its arguments and result stay in the turn's context, because
 * a result read from another workspace is never kept and a picture's bytes never are (`ledger.js` `toolEntry` keeps
 * each call's arguments and result with those rules). Its output says whether it failed and how long the result was.
 */
import { ADVISOR_TOOL } from "../../advisor.js";

const failed = (result) => result?.isError === true || result?.ok === false;
const sizeOf = (result) => (typeof result === "string" ? result.length : typeof result?.text === "string" ? result.text.length : 0);

export async function toolsNode(input, io) {
  const calls = io.ctx.turn.toolCalls;
  const held = calls.held.get(input.call);
  const { kind, name } = input;
  // A draft that makes the advisor one of the tools (Dev2, 2026-11-16) runs it as its own step over this step's `uses`
  // wire (it is an Opus call); main's config wires it to the front door instead.
  if (kind === "local" && name === ADVISOR_TOOL && "advisor" in io.use) {
    const advised = await io.use.advisor(input);
    return { failed: advised?.failed === true, chars: Number.isFinite(advised?.chars) ? advised.chars : 0 };
  }
  const result = await (kind === "web" ? calls.web(name, held.args) : kind === "local" ? calls.local.get(name)(held.args, held.turnSoFar) : calls.mcp(name, held.args));
  held.result = result;
  return { failed: failed(result), chars: sizeOf(result) };
}
