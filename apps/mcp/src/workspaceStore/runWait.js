/**
 * A job's read of its run on a computer, held by the workspace object until the run moves (Dev2, 2026-11-06: jobs
 * wait on pushes, with a slow safety read, instead of reading every ten seconds).
 *
 * The job's object read its run every 10 seconds for as long as a part ran (`apps/agent/src/machineTurn.ts`), and
 * every read wrote the run's steps to the chat's record again (`machines/jobRoutes.js` `ledgerSteps`). Now a read
 * names the version it last saw (`seen`) and how long it may wait (`waitMs`, at most `MAX_RUN_WAIT_MS`); the object
 * answers the moment the run's version differs, a step, a word, a session or its end, or when the wait is up. It looks
 * at its own row (a local SQLite read), so a held read costs the gateway one call.
 */

/** The longest one read is held: under a minute, so the reader's safety read is never more than that apart. */
export const MAX_RUN_WAIT_MS = 50_000;
/** How often a held read looks at its run: a local read, never a call. */
export const RUN_LOOK_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a reader has seen of a run: its state, steps, words, session and whether it ended. Never content. */
export function runVersion(run) {
  if (!run || typeof run !== "object") return "";
  const steps = Array.isArray(run.steps) ? run.steps.length : 0;
  const said = Array.isArray(run.said) ? run.said.length : 0;
  return [run.state ?? "", Number(run.lastStep) || 0, steps, said, run.session ?? "", run.result ? 1 : 0].join("|");
}

/**
 * The run, once it differs from `fields.seen` or the wait is up; at once with no `seen` or no wait, or when it ended.
 * `null` when there is no such run, or it is not `fields.askerId`'s when that is named.
 */
export async function heldRun(machines, fields, { now = Date.now, wait = sleep } = {}) {
  let run = machines.run(fields.runId);
  // A held read is only ever another person's run's no: whose run it is is checked before anything waits.
  if (run && typeof fields.askerId === "string" && run.askerId !== fields.askerId) return null;
  const waitMs = Math.min(MAX_RUN_WAIT_MS, Math.max(0, Number(fields.waitMs) || 0));
  if (!run || typeof fields.seen !== "string" || waitMs === 0) return run;
  const until = now() + waitMs;
  while (run && run.state !== "ended" && runVersion(run) === fields.seen) {
    const left = until - now();
    if (left <= 0) break;
    await wait(Math.min(RUN_LOOK_MS, left));
    run = machines.run(fields.runId);
  }
  return run;
}
