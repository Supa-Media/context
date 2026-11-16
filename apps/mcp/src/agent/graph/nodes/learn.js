/**
 * Learn node "learn" (`texConfig.json`; Dev2, 2026-11-16: Reflect and the Memory nudge, merged): after a texted turn,
 * what was learned is written down. The memory nudge puts it in About me every ten texts, or when the answer was about
 * them (`memoryNudge.js`); reflect writes a learned skill after a hard or corrected turn (`reflect.js`). Background:
 * Text them's `background` wire runs it after the reply, and nothing waits for it. Its input is only the small data
 * the wire carries; the session, store and turn come in `io.ctx`. Each half's outcome is its own field, and one that
 * fails never stops the other.
 */
import { nudgeAfterTurn, reflectAfterTurn } from "../../reflect.js";

/** One half's outcome; a half that throws is kept as failed, and the other still runs. */
async function half(run) {
  try {
    return (await run()) ?? { outcome: "none" };
  } catch (error) {
    return { outcome: "failed", error: String(error?.message ?? error).slice(0, 300) };
  }
}

export default async function learn(input, io) {
  const { question, answer, tainted, ownText, canWrite } = input;
  // One after the other, as they always ran: both may write to the same workspace.
  const nudge = await half(() => nudgeAfterTurn({ ...io.ctx, question, answer, tainted, canWrite }));
  const reflect = await half(() => reflectAfterTurn({ ...io.ctx, question, tainted, ownText, canWrite }));
  return { nudge, reflect };
}
