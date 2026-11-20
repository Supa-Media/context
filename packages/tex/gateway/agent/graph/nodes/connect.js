/**
 * Connect node "connect" (`noteConnect.js` `connectNotes`; Dev2, 2026-11-20: "score, then finder + connect step"):
 * after a turn that wrote notes, a model names the few other notes each one shares something real with, and code
 * writes each link both ways under `## Connections` with why. Background: Text them's `background` wire runs it after
 * the reply, and nothing waits for it. Its input is the notes the turn wrote and what the person said; the session,
 * store and turn come in `io.ctx`. On the shelf until a Lab draft wires it.
 */
import { connectNotes } from "../../noteConnect.js";
import { ownDispatch } from "../../reflect.js";

export default async function connect(input, io) {
  try {
    const { store, session, env } = io.ctx;
    return await connectNotes({
      ...io.ctx,
      dispatch: ownDispatch(store, session, env),
      paths: Array.isArray(input?.notes) ? input.notes : [],
      question: typeof input?.question === "string" ? input.question : "",
      tainted: input?.tainted === true,
      group: input?.group === true,
      node: io.node,
    });
  } catch (error) {
    // Never fails the turn: the reply is already sent.
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200) };
  }
}
