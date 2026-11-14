/**
 * Tex's day summaries: sums up each finished day of the chat that has no summary yet, after the dream
 * (`daySummaries.js`). Its wire from `dream` lives in texConfig.json, and fires only on the dream's `summarize` tag.
 */
import { summarizeDays } from "../../daySummaries.js";

export default async function daysum({ timeZone, now }, io) {
  return { outcome: await summarizeDays(io.ctx.env, io.ctx.store, io.ctx.session, now, timeZone) };
}
