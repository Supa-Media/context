/**
 * The reflect node: after a texted turn, the hard job is written down as a learned skill (`reflect.js`, `reflectAfterTurn`).
 * Background: the `send -> reflect` wire runs it after the reply, and nothing waits for it. Its input is only the small
 * data the wire carries; the session, store and turn come in `io.ctx`.
 */
import { reflectAfterTurn } from "../../reflect.js";

export default async function reflect(input, io) {
  return reflectAfterTurn({ ...io.ctx, ...input });
}
