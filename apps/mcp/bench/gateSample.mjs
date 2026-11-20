/**
 * THE REPLAY GATE'S SAMPLE (Dev2, 2026-11-15: "cut the big tests to be less big ... I'm more concerned about the speed
 * of things"; chose "Reply checker and jobs"). A change's replay runs a fixed part of the jobs, not all of them: an
 * examiner session answers every call by hand, and a full run had grown to about 494 calls (2026-11-15).
 *
 * - review and respond, the two unit steps, once sampled 20 each, now keep at most `UNIT_LIMIT` cases and run whole.
 * - jobs: `GATE_JOB_TASKS`, one task of each kind (3 of the 7 whole jobs).
 *
 * The full set of jobs stays in the repository and runs whole without `--gate-sample` (`pnpm ai jobs`).
 * Held-out cases always run whole. A case the change adds or edits always runs too, so a change still passes the
 * case that proves it (docs/decisions/testing/replay-gate.md). No imports, so the gate and the scorers share it freely.
 */

/**
 * The most cases any one step keeps (Dev2, 2026-11-15: "a max of 20 test cases per unit"; chose "keep best 20, delete
 * rest"). The reviewer's sets and Decide's cases were cut to 20 each, kept so every reviewer set and both kinds of
 * answer stay in; `scripts/tex-lab-data.mjs` fails when any step's cases pass it, so the bench never grows back.
 * Raised to 50 on 2026-11-17 (Dev2: "Replay cases, 20 per step - raise it to what you think makes sense"): every step
 * that had cases was full, so a fix could not add the case that proves it. The replay is on demand and capped at $1 a
 * change (`replayGate.mjs`); a step's case is one cheap call, so 50 keeps a step's run to cents. Raised to 100 on
 * 2026-11-20 (Dev2 chose it on a card): the pipeline's plumbing replays, which make no model call, were full at 50, and
 * a fix to the door's yes step could not add the case that proves it.
 */
export const UNIT_LIMIT = 100;

/** The job tasks a change's replay runs: one research page, one page edit, one errand. */
export const GATE_JOB_TASKS = ["research-caterers-page", "page-edit-fix-caterer-numbers", "errand-register-retreat-and-note"];

/** Ids of `cases` that are new or changed against `baseCases` (main's copy; an id main lacks is new). */
export function changedIds(cases, baseCases) {
  const base = new Map((baseCases ?? []).map((item) => [item.id, JSON.stringify(item)]));
  return new Set(cases.filter((item) => base.get(item.id) !== JSON.stringify(item)).map((item) => item.id));
}

/** The job tasks a change's replay runs, from the tasks and main's, as a set of ids. */
export function jobsSample(cases, baseCases) {
  const keep = new Set(GATE_JOB_TASKS.filter((id) => cases.some((item) => item.id === id)));
  for (const id of changedIds(cases, baseCases)) keep.add(id);
  return keep;
}

/** Whether a case runs: held-out always, otherwise when the sample (null for none) holds it. */
export const inSample = (sample) => (item) => sample === null || item.heldOut === true || sample.has(item.id);
