/**
 * Drop past-date lines (`aboutRecheck.js` `expireAbout`): after the dream, About me loses every line whose `until` day
 * has passed, by date and never by a model. On the shelf until a Lab draft wires it (`texNodeShelf.json`).
 */
import { expireAbout } from "../../aboutRecheck.js";

export default async function aboutExpire(input, io) {
  try {
    const timeZone = input?.timeZone ?? io.ctx.timeZone;
    const now = Number.isFinite(input?.now) ? input.now : Date.now();
    // The night's time zone and clock go on to the recheck, which the night's context does not carry.
    return { ...(await expireAbout({ dispatch: io.ctx.dispatch, timeZone, now })), ...(timeZone ? { timeZone } : {}), now };
  } catch (error) {
    // Never fails the night: the dream's answer is already made.
    return { outcome: "failed", error: String(error?.name ?? "Error"), why: String(error?.message ?? "").slice(0, 200), when: [] };
  }
}
