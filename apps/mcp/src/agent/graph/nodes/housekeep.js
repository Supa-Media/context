/**
 * Tex's housekeeping: tidies one person's workspace once a night within its time limit (`housekeeping.js`). Its wire
 * from `nightly` lives in texConfig.json, and fires only on the `housekeeping` run.
 */
import { housekeepNight } from "../../housekeeping.js";

export default async function housekeep(input, io) {
  return await housekeepNight({ ...io.ctx, timeZone: input.timeZone });
}
