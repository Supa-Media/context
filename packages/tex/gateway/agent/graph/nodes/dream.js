/**
 * Tex's nightly dream: keeps About me true from the chat since the last dream (`dream.js`). Its wires live in
 * texConfig.json: `nightly` starts it, and `dream` -> `daysum` runs the day summaries when its `when` says so.
 */
import { dreamNight } from "../../dream.js";

export default async function dream(input, io) {
  // Its budget is config (`limits.chars`): the size it keeps About me under (`aboutUpkeep.js`).
  return await dreamNight({ ...io.ctx, timeZone: input.timeZone, since: input.since ?? null, budget: io.node?.limits?.chars ?? null });
}
