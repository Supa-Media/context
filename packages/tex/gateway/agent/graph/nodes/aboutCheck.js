/**
 * Recheck About me (`aboutRecheck.js` `recheckAbout`): once a week (its `limits.everyDays`), a model checks About me's
 * older dated lines against their mail, calendar and notes; code applies its drops and rewrites, and it can never add
 * a line. `force` (the Lab's Run now) runs it whatever the date. On the shelf until a Lab draft wires it.
 */
import { recheckAbout } from "../../aboutRecheck.js";

export default async function aboutCheck(input, io) {
  try {
    return await recheckAbout({
      ...io.ctx,
      timeZone: input?.timeZone ?? io.ctx.timeZone,
      now: Date.now(),
      force: input?.force === true || io.ctx.force === true,
      node: io.node,
    });
  } catch (error) {
    // Never fails the night: the dream's answer is already made.
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200) };
  }
}
