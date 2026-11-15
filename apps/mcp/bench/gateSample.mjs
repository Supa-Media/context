/**
 * THE REPLAY GATE'S SAMPLE (Dev2, 2026-11-15: "cut the big tests to be less big ... I'm more concerned about the speed
 * of things"; chose "Reply checker and jobs"). A change's replay runs a fixed part of the two biggest areas, not all
 * of it: an examiner session answers every call by hand, and a full run had grown to about 494 calls (2026-11-15).
 *
 * - review: the first `REVIEW_PER_KIND` faults and the first `REVIEW_PER_KIND` good replies of each set, in file order
 *   (15 sets, about 60 of the 211 cases).
 * - jobs: `GATE_JOB_TASKS`, one task of each kind (3 of the 7 whole jobs).
 *
 * The full sets stay in the repository and run whole without `--gate-sample` (`pnpm ai review`, `pnpm ai jobs`).
 * Held-out cases always run whole. A case the change adds or edits always runs too, so a change still passes the
 * case that proves it (docs/decisions/testing/replay-gate.md). No imports, so the gate and the scorers share it freely.
 */

/** Faults and good replies kept from each reviewer set. */
export const REVIEW_PER_KIND = 2;

/** The job tasks a change's replay runs: one research page, one page edit, one errand. */
export const GATE_JOB_TASKS = ["research-caterers-page", "page-edit-fix-caterer-numbers", "errand-register-retreat-and-note"];

/** Ids of `cases` that are new or changed against `baseCases` (main's copy; an id main lacks is new). */
export function changedIds(cases, baseCases) {
  const base = new Map((baseCases ?? []).map((item) => [item.id, JSON.stringify(item)]));
  return new Set(cases.filter((item) => base.get(item.id) !== JSON.stringify(item)).map((item) => item.id));
}

/** The reviewer cases a change's replay runs, from `{ [set]: cases }` and main's sets, as a set of ids. */
export function reviewSample(sets, baseSets) {
  const keep = new Set();
  for (const cases of Object.values(sets)) {
    for (const fault of [true, false]) {
      for (const item of cases.filter((c) => Boolean(c.fault) === fault).slice(0, REVIEW_PER_KIND)) keep.add(item.id);
    }
  }
  for (const id of changedIds(Object.values(sets).flat(), Object.values(baseSets ?? {}).flat())) keep.add(id);
  return keep;
}

/** The job tasks a change's replay runs, from the tasks and main's, as a set of ids. */
export function jobsSample(cases, baseCases) {
  const keep = new Set(GATE_JOB_TASKS.filter((id) => cases.some((item) => item.id === id)));
  for (const id of changedIds(cases, baseCases)) keep.add(id);
  return keep;
}

/** Whether a case runs: held-out always, otherwise when the sample (null for none) holds it. */
export const inSample = (sample) => (item) => sample === null || item.heldOut === true || sample.has(item.id);
