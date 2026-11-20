/**
 * Drop past-date lines (`aboutRecheck.js` `expireAbout`): after the dream, About me loses every line whose `until` day
 * has passed, by date and never by a model. On the shelf until a Lab draft wires it (`texNodeShelf.json`).
 */
import { expireAbout } from "../../aboutRecheck.js";

export default async function aboutExpire(input, io) {
  try {
    return await expireAbout({ dispatch: io.ctx.dispatch, timeZone: input?.timeZone ?? io.ctx.timeZone, now: Number.isFinite(input?.now) ? input.now : Date.now() });
  } catch (error) {
    // Never fails the night: the dream's answer is already made.
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200), when: [] };
  }
}
