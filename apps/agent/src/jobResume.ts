/**
 * Which saved rounds a background job's part goes on from (Dev2, 2026-11-17: "jobs must be reliable"; built on the
 * texted turn's resume, `apps/mcp/src/agent/turnResume.js`, plan reviewed by Fable the same day).
 *
 * The gateway keeps each part's rounds in the chat's own home as its calls return, and reads back only the part this
 * names (`resumeFrom`), so a part that dies goes on from its last call instead of searching and reading again:
 * - this part again, when its last try died (a retry, or a pass whose object died mid-part);
 * - the part before, when it was cut off before it answered (a crash or its time running out).
 * A try that was handed saved rounds and still did not answer is followed by a fresh one: what killed it may be in
 * them, so they are never carried twice in a row. A part on their own computer keeps none (it runs elsewhere).
 */
import type { JobAsk, JobRun } from "./jobs";

/** What a part's ask carries, and whether the run changed (it is written before the ask, so a pass that dies keeps it). */
export function resumePlan(run: JobRun, hadProgress: boolean): { ask: Pick<JobAsk, "resumes" | "resumeFrom">; changed: boolean } {
  const resumes = run.resumes ?? 0;
  const base = resumes > 0 ? { resumes } : {};
  if (run.machine !== undefined) return { ask: base, changed: false };
  // The last try was handed saved rounds and did not answer: this one starts fresh, and the mark goes.
  if (run.resumedTry !== undefined) {
    delete run.resumedTry;
    return { ask: base, changed: true };
  }
  const from = run.tries > 0 || hadProgress ? run.attempt : run.carryFrom === run.attempt - 1 && run.attempt > 1 ? run.carryFrom : undefined;
  if (from === undefined) return { ask: base, changed: false };
  run.resumedTry = run.attempt;
  return { ask: { ...base, resumeFrom: from }, changed: true };
}

/**
 * What the next part's run keeps of this one's resume: the part to go on from, when this one was cut off before it
 * answered and was not itself handed saved rounds (`resumePlan` then starts fresh); the advice it was following, which
 * those rounds were made under. The marks of this part's own try go with it.
 */
export function carryPatch(run: JobRun, outcome: { kind: string; cause?: string }): Pick<JobRun, "carryFrom" | "advice"> {
  if (outcome.kind !== "broken" || (outcome.cause !== "crash" && outcome.cause !== "timeout") || run.machine !== undefined) return {};
  return { ...(run.resumedTry === undefined ? { carryFrom: run.attempt } : {}), ...(run.advice ? { advice: run.advice } : {}) };
}
