/**
 * `POST /gateway/usage/export` — the gateway's hourly Context usage run asking what happened since `since`
 * (`functions/usagePeople.ts`, `lib/usagePeopleTimings.ts`). Gateway-only, like every `/gateway/` route.
 *
 * Answers ids, days, times, tool names and numbers: the person-days (already MACs), the accounts made and the
 * owners of personal workspaces that texted (account ids, for the gateway to MAC before anything is written), and
 * the call and reply timings, the app's own vitals (platform, kind, ms and a random session id: `functions/appVitals.ts`), and the bug reports people sent (account ids and the reference they were told). Never a name, an address, a path or a word.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json } from "../gatewayAuth";
import { usageTimings, type UsageTimings } from "../usagePeopleTimings";
import { MAX_EXPORT_DAYS, type UsageExport } from "../../usagePeople";
import { VITALS_RETENTION_DAYS, type VitalsExport } from "../../appVitals";

const DAY_MS = 86_400_000;

export async function gatewayUsageExportHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const now = Date.now();
  const since = typeof body.since === "number" && Number.isFinite(body.since) ? Math.max(body.since, now - MAX_EXPORT_DAYS * DAY_MS) : now - 7 * DAY_MS;
  const bugsSince = typeof body.bugsSince === "number" && Number.isFinite(body.bugsSince) ? Math.max(body.bugsSince, now - MAX_EXPORT_DAYS * DAY_MS) : since;
  // Calls are read back 14 days at most: the sheet keeps no more, and a busy fortnight stays under its rows.
  const callsSince = Math.max(since, now - 14 * DAY_MS);
  const vitalsSince = Math.max(since, now - VITALS_RETENTION_DAYS * DAY_MS);
  const [rows, vitals, timings]: [UsageExport, VitalsExport, UsageTimings] = await Promise.all([
    ctx.runQuery(internal.functions.usagePeople.exportRows, { since, bugsSince }),
    ctx.runQuery(internal.functions.appVitals.exportRows, { since: vitalsSince }),
    usageTimings(
      {
        CLOUDFLARE_ANALYTICS_TOKEN: process.env.CLOUDFLARE_ANALYTICS_TOKEN,
        CLOUDFLARE_ANALYTICS_ACCOUNT_ID: process.env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID,
        APP_ENV: process.env.APP_ENV,
      },
      callsSince,
    ),
  ]);
  return json({ ...rows, cut: rows.cut || vitals.cut, vitals: vitals.vitals, calls: timings.calls.filter((call) => call.at >= callsSince), replies: timings.replies, timingsError: timings.error });
}
