/**
 * The memory nudge node: every 10 texts, or when an answer was about them, what was learned goes into About me now
 * (`memoryNudge.js`, `nudgeAfterTurn`). Background: the `send -> nudge` wire runs it after the reply, and nothing waits
 * for it. Its input is only the small data the wire carries; the session, store and turn come in `io.ctx`.
 */
import { nudgeAfterTurn } from "../../reflect.js";

export default async function nudge(input, io) {
  return nudgeAfterTurn({ ...io.ctx, ...input });
}
