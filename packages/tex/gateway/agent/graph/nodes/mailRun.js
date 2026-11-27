/**
 * Node "mailRun" (`../../mailRunRoute.js`; Dev, 2026-11-27: "Tex in mail should be the same flow as tex in comments I
 * feel, its own mini tex"). Tex answers the new lines sent to a person's own Tex on a note's mail, the way it answers
 * in a note's comments (`../../noteRun.js` `runNoteRun`): the note, the mail as the thread, the person's Tex chat and
 * their notes. The route starts it with the note and the new lines; the session, dispatch, ledger and node come in
 * `io.ctx`. Never fails the route: the run is reported failed, and nothing is sent.
 */
import { runNoteRun } from "../../noteRun.js";
import { ownDispatch } from "../../reflect.js";

export default async function mailRun(input, io) {
  try {
    const { store, session, env } = io.ctx;
    return await runNoteRun({ ...io.ctx, ...input, dispatch: io.ctx.dispatch ?? ownDispatch(store, session, env), node: io.node });
  } catch (error) {
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200) };
  }
}
