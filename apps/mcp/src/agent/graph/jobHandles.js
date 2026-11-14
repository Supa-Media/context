/**
 * The running job node's `io`, by job id, for the code a pass reaches (Job check, the Hand-back judge, the Advisor on
 * job mail). While a job's pass runs, `nodes/job.js` lends its io under the job's id; a caller that finds it reaches
 * those nodes through the job's own wires (`io.use.jobcheck`, `io.job.handback`, `io.use.mailadv`), and the runner
 * checks and logs them as the config says. A caller that finds nothing falls back to the bridges (`bridges.js`).
 *
 * In-isolate only: this Map lives in one isolate, so a pass run by another isolate (or a Worker-run job, which never
 * lends) finds nothing and takes the bridge. Nothing here is durable, and nothing here is a second copy of a job.
 */

/** @type {Map<string, object>} */
const running = new Map();

/** Lend the io of the job node running for `jobId`. */
export function lendJob(jobId, io) {
  if (typeof jobId !== "string") return;
  running.set(jobId, io);
}

/** The io lent for `jobId`, or null when no job node is running for it here (or the id is not a string). */
export function borrowJob(jobId) {
  if (typeof jobId !== "string") return null;
  return running.get(jobId) ?? null;
}

/** Take back the io lent for `jobId`; deletes only when the stored io is this one, so a later lend is not removed. */
export function returnJob(jobId, io) {
  if (typeof jobId !== "string") return;
  if (running.get(jobId) === io) running.delete(jobId);
}
