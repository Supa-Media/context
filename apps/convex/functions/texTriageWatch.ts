/**
 * The watch on Tex's triage desk: a mail to the team inbox when conversation
 * reviews and texted bug reports sit untouched for hours (the owner,
 * 2026-10-26, "fix the gaps"; `docs/decisions/texting-assistant/self-review.md`).
 *
 * The reader that turns reports into fixes is an agent on an hourly pass, and
 * an agent can stop: before this, a stopped pass left reports at `status: new`
 * and nothing said so. Here the desk's own rows are counted (`texTriage.ts`,
 * from each note's front matter, never its words): a review still `new`, or a
 * bug still `open` with no theme named (triage files a bug under a theme and
 * may leave it open while the fix runs), filed more than `STALE_AFTER_MS` ago
 * means no pass has read it in three of its hours. Only the last
 * `LOOKS_BACK_MS` count: an old report left untouched before this watch
 * existed says nothing about whether triage is running now.
 *
 * The mail carries a count and a time, never a report's words or who filed
 * it, and goes only to `SIGNUP_ALERTS_EMAIL`, the one team inbox; a
 * deployment without one (a self-hoster's) mails nobody. At most one mail per
 * `ALERT_EVERY_MS` while the desk stays stuck. It decides nothing: it only
 * says the desk is waiting.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { triageFolders, triageRows } from "./lib/adminFns/texTriage";
import { validAppOrigin } from "./lib/invitationEmail";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { teamInbox } from "./signupAlerts";

/** Three missed hourly passes. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** Reports filed longer ago than this are not counted. */
export const LOOKS_BACK_MS = 3 * 24 * 60 * 60 * 1000;
/** While it stays stuck, a reminder this often and no more. */
export const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

/** How many reports are waiting past the limit, and when the oldest was filed. */
export function waitingOf(
  desk: { reviews: { status: string; reviewed: number | null }[]; bugs: { status: string; filed: number | null; themes: string[] }[] },
  now: number,
): { waiting: number; oldest: number | null } {
  const at = [
    ...desk.reviews.filter((review) => review.status.toLowerCase() === "new").map((review) => review.reviewed),
    ...desk.bugs.filter((bug) => bug.status.toLowerCase() === "open" && bug.themes.length === 0).map((bug) => bug.filed),
  ].filter((when): when is number => when !== null && when < now - STALE_AFTER_MS && when > now - LOOKS_BACK_MS);
  return { waiting: at.length, oldest: at.length === 0 ? null : Math.min(...at) };
}

export const waiting = internalQuery({
  args: { now: v.number() },
  returns: v.object({ waiting: v.number(), oldest: v.union(v.number(), v.null()) }),
  handler: async (ctx, { now }) => {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null) return { waiting: 0, oldest: null };
    const folders = triageFolders((await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null);
    // Counted for the team inbox only, so every row counts; nothing about a row leaves but its time.
    return waitingOf(await triageRows(ctx.db, pinned._id, folders, () => true), now);
  },
});

/** True when this stall may be mailed now. */
export const claimAlert = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await tryConsumeRateLimit(ctx, { key: "texTriageWatch", limit: 1, windowMs: ALERT_EVERY_MS }),
});

export function renderTriageAlert(waitingCount: number, oldest: number, deskUrl: string) {
  const since = new Date(oldest).toISOString().replace("T", " ").slice(0, 16);
  const reports = waitingCount === 1 ? "1 Tex report has" : `${waitingCount} Tex reports have`;
  const text = [
    `${reports} waited more than 3 hours for triage. The oldest was filed ${since} UTC.`,
    "",
    "The hourly triage pass has probably stopped. Restart the \"Triage Tex conversation reviews\" thread in the Tex project.",
    "",
    `Desk: ${deskUrl}`,
  ].join("\n");
  return { subject: `Tex triage has stalled: ${waitingCount} waiting`, text };
}

export const check = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const log = (outcome: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event: "tex_triage_watch", outcome, ...extra }));
    const to = teamInbox();
    const apiKey = process.env.RESEND_API_KEY;
    const origin = validAppOrigin();
    if (to === null || typeof apiKey !== "string" || apiKey.length === 0 || origin === null) return null;
    const found = await ctx.runQuery(internal.functions.texTriageWatch.waiting, { now: Date.now() });
    if (found.waiting === 0 || found.oldest === null) return null;
    if (!(await ctx.runMutation(internal.functions.texTriageWatch.claimAlert, {}))) {
      log("already_told", { waiting: found.waiting });
      return null;
    }
    const mail = renderTriageAlert(found.waiting, found.oldest, new URL("/admin", origin).toString());
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM ?? "hello@context.lc", to, subject: mail.subject, text: mail.text }),
      });
      log(response.ok ? "sent" : "failed", { waiting: found.waiting, ...(response.ok ? {} : { status: response.status }) });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});
