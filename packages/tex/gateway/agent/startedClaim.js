/**
 * "Started it" checked against what the turn started (Architect item #7, 2026-11-28; the 2026-11-06 split: the only
 * call was a steer into the MacBook's job, and the reply said "Sent ✓. The split job now includes the Tex cloud
 * workers as a third part", so the person waited on a part that never ran).
 *
 * A reply that says it started, restarted or picked back up a job, or added a part or worker to one, goes back once
 * when no call this turn started a job (`start_background_job`, `plan_big_ask`) or picked one back up
 * (`restart_background_job`). The notice is the turn's facts as data, what it started, picked back up and passed to
 * running jobs, never words for Tex to say (docs/decisions/texting-assistant/no-scripted-wording.md). A start that
 * went through ends the turn on its own line (`background.js` `endsTurn`), so it never reaches this.
 */

/** The calls that start a job, or pick one back up. */
export const STARTS = new Set(["start_background_job", "plan_big_ask", "restart_background_job"]);
const STEER = "steer_background_job";

const STARTED = /\b(?:started|kicked off|spun up|launched|restarted|re-started|set off|picked\b.{0,40}\bback up)\b.{0,60}\b(?:jobs?|parts?|workers?|background)\b/i;
const PICKED = /\bpicked\b.{0,40}\b(?:jobs?|parts?)\b.{0,20}\bback up\b/i;
const ADDED = /\b(?:added|adding|includes?|including)\b.{0,60}\b(?:as an? (?:\w+ )?(?:part|worker|job)|(?:second|third|fourth|new|another) (?:part|worker|job))\b/i;
const NOT = /\b(?:not|never|no|couldn't|can't|cannot|won't|didn't|haven't|hasn't|wasn't|unable)\b/i;

/** Whether one of the answer's sentences says a job was started, picked back up, or given a part. */
export function claimsAStart(answer) {
  return String(answer ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => !sentence.includes("?") && !NOT.test(sentence) && (STARTED.test(sentence) || PICKED.test(sentence) || ADDED.test(sentence)));
}

/**
 * The notice for a start claim nothing in the turn backs, or null. `steps`: the turn's calls, as `standsCheck.js`
 * `stepOf` keeps them (`name`, `ok`, `args`).
 */
export function startedClaimNotice(answer, steps) {
  if (steps.some((step) => step.ok && STARTS.has(step.name)) || !claimsAStart(answer)) return null;
  const steered = steps.filter((step) => step.ok && step.name === STEER).map((step) => {
    try {
      return String(JSON.parse(step.args)?.title ?? "");
    } catch {
      return "";
    }
  }).filter(Boolean);
  return JSON.stringify({ check: "start_claim", answer_claims: "job_started", started_this_turn: [], picked_back_up_this_turn: [], passed_to_running_jobs: steered });
}
