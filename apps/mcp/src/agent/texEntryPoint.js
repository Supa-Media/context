/**
 * THE TEX ENTRY POINT (Dev, 2026-11-03: "a standalone single file with one function"; 2026-11-04: "why can't it be
 * called texEntrypoint"). Its steps are timed by `texTiming.js`.
 *
 * Every text to Tex, every group chat turn, job, report and routine run goes through `texEntryPoint`. The turn is one
 * run of Tex's config graph (`graph/turnGraph.js`, Dev2, 2026-11-14: "it's not fine for the connections between node
 * to be code"): the door steps, each a node of group "door" whose code is its file under `texEntryPoint/`, then the
 * front door, the checks on its drafts and the way out, in the order and on the branches `texConfig.json`'s wires say.
 * A door step that answers the turn sends it straight to Text them, on a wire tagged `answered`.
 *
 * `t` is the turn: what was asked and what each node found, shared by every node as the run's context. Every wait
 * inside a step is timed by name (`texTiming.js`), so a turn's breakdown shows exactly where its time went.
 */

import { texEntry } from "./texTiming.js";
import { runTurnGraph } from "./graph/turnGraph.js";
import * as steps from "./texEntryPoint/steps.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call or one step of the turn: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function texEntryPoint(request, env, store, session, controlPlane, { progress = null, step = null, answered = null, stages = null, tex = texEntry(env) }, outcome) {
  const t = { request, env, store, session, controlPlane, outcome, progress, step, answered, stages, tex };
  try {
    return await tex.step("graph", () => runTurnGraph(t)); // the whole turn, as the config's wires run it
  } catch (error) {
    // A turn that threw once the front door began (`t.drafts`, `graph/nodes/fd.js`) is recovered; one that threw at the door was never caught there.
    if (t.drafts === undefined) throw error;
    return await steps.recoverFromFailure(t, error);
  }
}
// TEX ENTRY POINT: end
