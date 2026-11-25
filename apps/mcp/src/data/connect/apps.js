/**
 * The apps an owner connects once for the whole workspace, each with the read-only key it takes, the one dataset it
 * keeps in its source folder, and how a run reads it (`docs/decisions/data-and-metrics.md`). GitHub joins when its
 * App is set up (stage F). The payments app waits on whether the exit guard may name it as a customer's own data
 * (`scripts/check-exit-is-ungated.mjs` keeps its name off every file under `apps/mcp/src`).
 */

import { CLOUDFLARE_DAYS, CLOUDFLARE_SOURCE, checkCloudflareToken, fetchCloudflareRows } from "./cloudflare.js";

export const APPS = Object.freeze({
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
