/**
 * The apps an owner connects once for the whole workspace, each with the read-only key it takes, the one dataset it
 * keeps in its source folder, and how a run reads it (`docs/decisions/data-and-metrics.md`). GitHub joins when its
 * App is set up (stage F).
 */

import { CLOUDFLARE_DAYS, CLOUDFLARE_SOURCE, checkCloudflareToken, fetchCloudflareRows } from "./cloudflare.js";
import { STRIPE_MAX_PAGES, STRIPE_SOURCE, checkStripeKey, fetchStripeRows } from "./stripe.js";

const DAY_MS = 86_400_000;
/** A run reads back this far past the newest row it already has, so a late change to a recent row is caught. */
const OVERLAP_MS = 3 * DAY_MS;

/**
 * Stripe lists newest first, so a run reads two windows, each under half the page cap: from the newest kept row
 * (less the overlap) to now, and the history still missing, from 400 days back to the oldest kept row. A new sheet
 * is all history. Each run then carries the history further back until a run finds none left.
 */
async function readStripe({ kept, newestMs, oldestMs, now, keepDays, fetcher }) {
  const floor = now - keepDays * DAY_MS;
  const pages = Math.floor(STRIPE_MAX_PAGES / 2);
  if (!Number.isFinite(newestMs)) return fetchStripeRows({ kept, fetcher, sinceMs: floor, pages: STRIPE_MAX_PAGES });
  const recent = await fetchStripeRows({ kept, fetcher, sinceMs: Math.max(newestMs - OVERLAP_MS, floor), pages });
  if (!recent.ok) return recent;
  if (!(oldestMs > floor)) return recent;
  const history = await fetchStripeRows({ kept, fetcher, sinceMs: floor, beforeMs: oldestMs, pages });
  if (!history.ok) return history;
  return { ok: true, rows: [...recent.rows, ...history.rows], more: recent.more || history.more };
}

export const APPS = Object.freeze({
  stripe: Object.freeze({
    ...STRIPE_SOURCE,
    check: checkStripeKey,
    read: readStripe,
  }),
  cloudflare: Object.freeze({
    ...CLOUDFLARE_SOURCE,
    check: checkCloudflareToken,
    read: ({ kept, now, fetcher }) => fetchCloudflareRows({ kept, now, fetcher }),
    days: CLOUDFLARE_DAYS,
  }),
});

/** The app a `source:` line names, or null. */
export function appNamed(word) {
  const key = String(word ?? "").trim().toLowerCase();
  return Object.hasOwn(APPS, key) ? key : null;
}
