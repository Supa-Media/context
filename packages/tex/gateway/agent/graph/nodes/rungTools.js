/**
 * Rungs 3 and 4 of the lookup ladder, `rungTools` ("Apps and web search"; `../../lookupLadder.js`, on the node shelf):
 * which of the front door's own lookups this turn already tried, read from its messages: a connected app (mail,
 * calendar, Google Chat), web search, and further up the browser and the advisor. The Before-asking step sends the
 * draft back naming the fast ones still untried. A connected app whose call failed is a broken connector: it says so,
 * and the ask goes to the person, never around it through the browser (Dev2, 2026-11-20).
 *
 * Output: `{ tried: rungs, failedApps }`. No model, never throws.
 */
import { triedRungs } from "../../lookupLadder.js";

export async function rungToolsNode(_input, io) {
  const t = io?.ctx?.turn ?? {};
  const { tried, failedApps } = triedRungs(t?.drafts?.waiting?.info?.messages);
  return { tried: [...tried], failedApps };
}
