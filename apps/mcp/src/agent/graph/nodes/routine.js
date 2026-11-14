/**
 * ROUTINE RUNS, the start node of a routine's run (`texConfig.json` "routine"): the turn a routine's own connection
 * asks for when the control plane says a routine under `tex/routines/` is due. Whether a turn is a routine's run is
 * the grant's client, never the body (`routine.js` `ROUTINES_CLIENT_ID`), so the graph starts here for that client and
 * at the door's first step for every other one (`turnGraph.js`). The door then reads the request, and Run a routine
 * reloads the routine and stops a paused or vanished one (`texEntryPoint/runARoutine.js`).
 *
 * Output: `client`, the grant's client that started it. No model, and it decides nothing the door does not check again.
 */
import { ROUTINES_CLIENT_ID } from "../../routine.js";

/** Whether the turn `t` is a routine's run: its grant is a routine runner's. */
export function startsAtRoutine(t) {
  return t?.session?.actorClientId === ROUTINES_CLIENT_ID;
}

export async function routine(_input, io) {
  const t = io.ctx.turn;
  if (!startsAtRoutine(t)) throw new Error("a routine's run starts only from a routine's own connection");
  return { client: ROUTINES_CLIENT_ID };
}
