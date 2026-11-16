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
import { runDoor } from "../door.js";

/** Whether the turn `t` is a routine's run: its grant is a routine runner's. */
export function startsAtRoutine(t) {
  return t?.session?.actorClientId === ROUTINES_CLIENT_ID;
}

/** The routine as data for the log and the Front door: its note, how many runs it has kept, and whether they answer it. */
function routineOf(t) {
  const e = t.engagement ?? {};
  return {
    path: String(t.routine?.path ?? ""),
    runs: Array.isArray(t.runs) ? t.runs.length : 0,
    supervised: t.supervision !== null && t.supervision !== undefined,
    texted: Number.isFinite(e.texted) ? e.texted : 0,
    unanswered: Number.isFinite(e.unanswered) ? e.unanswered : 0,
    lastAnsweredAt: Number.isFinite(e.lastAnsweredAt) ? e.lastAnsweredAt : null,
  };
}

/**
 * The node. Main's config wires it to the door's first step, so a routine's run goes on through the door; a Lab draft
 * that wires it straight to the Front door (Dev2, 2026-11-16: "routines shouldn't act as a message you've sent, they
 * should act like routines") makes it run the door's parts itself (`../door.js`, each logged in this row), with what
 * it knows of its runs and whether the person answers them (`routineEngagement.js`), and log the routine (`run`), the Front door being told it through the turn (`runARoutine.js`); a paused or vanished routine, or a job that needs no model, ends here (`stopped`), its outcome kept
 * for Text them. `steps` is the door's parts, swapped only by a test.
 */
export async function routine(_input, io, steps) {
  const t = io.ctx.turn;
  if (!startsAtRoutine(t)) throw new Error("a routine's run starts only from a routine's own connection");
  if (typeof io.ctx.wired !== "function" || !io.ctx.wired("routine", "fd")) return { client: ROUTINES_CLIENT_ID };
  t.asRoutine = true; // `runARoutine.js`: the run is told its standing (`routineEngagement.js`)
  const { answer, answeredBy, parts, handed } = await runDoor(t, io.ctx, Date.now, steps);
  if (answer !== undefined) {
    t.response = answer;
    return { when: ["stopped"], answeredBy, status: answer?.status, log: { parts, routine: routineOf(t) } };
  }
  return { when: ["run"], ...handed, log: { parts, routine: routineOf(t) } };
}
