/**
 * A CHECK-IN'S LOOK AS THE FRONT DOOR NODE (Dev2, 2026-11-14: "it's not fine for the connections between node to be
 * code"; 2026-11-22: a Lab test chat's check-in said its answer check "logged no run").
 *
 * `heartbeat.js` runs a check-in as the config's graph from Check-in; this is the code it puts in the Front door's place
 * (`checkin -> fd`), on the same draft bridge a text's Front door uses (`graph/draftBridge.js`, `graph/nodes/fd.js`).
 */
import { draftBridge } from "./graph/draftBridge.js";

/**
 * The check-in's look as the Front door node (`checkin -> fd`, mode wait), on the texts' bridge (`graph/draftBridge.js`):
 * it runs the look the Check-in node prepared (`t.look`) and stops at each draft it would send, which the config's
 * `fd -> answerCheck` wire takes to the Answer check; that node's `loop` wire brings it back here with its notice
 * (`null` lets it go), and the look goes on where it stopped. A finished look's turn is kept in `t.turn` for Text them.
 */
export async function checkInLook(input, io) {
  const t = io.ctx.turn;
  if (t.drafts?.waiting) return lookStop(t, await t.drafts.resume(input?.notice ?? null)); // back from the Answer check
  const drafts = (t.drafts = draftBridge());
  return lookStop(t, await drafts.start(t.look(t.answerChecks === null ? null : drafts.answerCheck, "tools" in io.use ? toolsVia(t, io.use.tools) : null)));
}

/**
 * Each tool call the look makes, over the Front door's `fd -> tools` wire as a text's are (`graph/nodes/fd.js`): the
 * wire carries the call's number and the tool's name, and its arguments and result stay in `t.toolCalls`.
 */
function toolsVia(t, tools) {
  const calls = (t.toolCalls = { mcp: null, web: null, local: new Map(), held: new Map() });
  let n = 0;
  const through = async (kind, name, args) => {
    n += 1;
    const call = n;
    calls.held.set(call, { args });
    try {
      await tools({ kind, name, call });
      return calls.held.get(call).result;
    } finally {
      calls.held.delete(call);
    }
  };
  return {
    tools: (inner) => ((calls.mcp = inner), (name, args) => through("mcp", name, args)),
    web: (web) => {
      if (!web || typeof web.call !== "function") return web;
      calls.web = (name, args) => web.call(name, args);
      return Object.assign(Object.create(web), { call: (name, args) => through("web", name, args) });
    },
  };
}

/** A stop of the look as the Front door's output: a draft waiting on its check, or the look done. */
function lookStop(t, stop) {
  if (stop.paused) return { when: ["drafted"], pending: true, draftChars: String(stop.draft ?? "").length };
  const turn = stop.value;
  t.turn = turn;
  return {
    when: ["done"],
    pending: false,
    draftChars: String(turn?.answer ?? "").length,
    ...(typeof turn?.model === "string" ? { answeredBy: turn.model } : {}),
    steps: Array.isArray(turn?.steps) ? turn.steps.length : 0,
    exhausted: turn?.exhausted === true,
  };
}
