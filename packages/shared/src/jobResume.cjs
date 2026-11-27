/**
 * Job restart: whether a background job that ended can be picked back up (Dev2, 2026-11-27, "Stop Tex parts drifting
 * out of sync"). One rule, read by every part that decides or describes it.
 *
 * Three parts held their own copy of this. The job's object keeps its run for two hours after it ended, or two hours
 * past the restart of a job paused at the daily limit (`packages/tex/worker/jobRun.ts`); the chat's inbox picks a job
 * back up when it is neither running nor done (`packages/tex/worker/jobs.ts` `resumeJobs`); and the gateway offered
 * "restart_job" for any job neither running nor done (`packages/tex/gateway/agent/background.js`), with no window. A
 * test chat kept an ended job a day (`jobsKept`), so Tex told a chat it was "restarting" a job whose run had already
 * gone, and the inbox then refused it. Now the window and the states are here, and all three read them.
 *
 * Plain CommonJS with no imports, so the gateway and the texting Worker read the same rule.
 */

/** How long an ended job's run is kept, so how long it can be picked back up: also how long every turn is shown it. */
const RESUME_MS = 2 * 60 * 60 * 1000;

/** When an ended job's run is let go: two hours after it ended, or after the restart of one paused at the limit. */
function resumeEndsAt(entry) {
  const from = [entry?.resumeAt, entry?.finishedAt, entry?.startedAt].find((n) => Number.isFinite(n) && n > 0);
  return from === undefined ? 0 : from + RESUME_MS;
}

/** True when a job ended without finishing and its run is still kept, so "restart it" can pick it up where it stopped. */
function canResume(entry, now) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.state === "running" || entry.state === "done") return false;
  return Number.isFinite(now) && now <= resumeEndsAt(entry);
}

module.exports = { RESUME_MS, canResume, resumeEndsAt };
