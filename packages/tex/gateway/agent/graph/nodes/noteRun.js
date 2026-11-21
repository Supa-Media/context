/**
 * Node "noteRun" (`../../noteRun.js` `runNoteRun`; Dev2, 2026-11-20: headless Tex inside notes: reads the 1:1 and notes,
 * writes nothing to the chat; runs with the asker's own access). Tex answers a question asked from a note's comment
 * thread: it reads the note, the asker's 1:1 Tex chat and their notes, and writes nothing. The route starts it with the
 * note, the thread and the highlight; the session, dispatch, ledger and onStep come in `io.ctx`. On the shelf until a
 * Lab draft wires it.
 */
import { runNoteRun } from "../../noteRun.js";
import { ownDispatch } from "../../reflect.js";

export default async function noteRun(input, io) {
  try {
    const { store, session, env } = io.ctx;
    return await runNoteRun({
      ...io.ctx,
      ...input,
      dispatch: io.ctx.dispatch ?? ownDispatch(store, session, env),
      node: io.node,
    });
  } catch (error) {
    // Never fails the route: the run is reported failed, and nothing is written.
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200) };
  }
}
