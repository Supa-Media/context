/**
 * `fill_dates` (`manage` action `fill_dates`): the one backfill pass for date properties (Dev2, 2026-11-10;
 * `notes/dateStamp.js`). Every note in this context that has `date created`, `date modified` or one of their usual
 * spellings with no value is filled from its own history: when it was first saved, and when its text last changed.
 * A key with a value is left alone, and a note without the keys is never touched.
 *
 * The owner's, like a link: it writes across the whole context, so a connection below the private tier is refused.
 * A long context is done in passes; the answer says how many notes were filled and where to go on from.
 */

import { fillDatesPage } from "../notes/dateStamp.js";
import { toolError, toolText } from "./results.js";

const NOT_YOURS = "Not run: only the owner can fill date properties across a context, from a connection with full access.";

export async function toolFillDates(store, scope, args = {}) {
  if (scope !== "private") return toolError(NOT_YOURS);
  const after = typeof args?.after === "string" && args.after !== "" ? args.after : null;
  let page;
  try {
    page = await fillDatesPage(store, { after });
  } catch {
    return toolError("Not finished: the pass could not run just now. Try again later; nothing it filled is undone.");
  }
  if (!page.served) {
    return toolError("Not run: this context's notes have not moved into its workspace object yet, so their history cannot be read here. Date properties still fill on every new save.");
  }
  const filled = `Filled date properties in ${page.filled} note${page.filled === 1 ? "" : "s"}`;
  const looked = `${page.looked} had a date key with no value`;
  if (page.next !== null) return toolText(`${filled} (${looked} so far). More are left: call fill_dates again with args { after: ${JSON.stringify(page.next)} }.`);
  return toolText(`${filled}; ${looked}. That was every one.`);
}
