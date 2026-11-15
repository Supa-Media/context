/**
 * THE REPLAY GATE'S SAMPLE (Dev2, 2026-11-15: "cut the big tests to be less big ... I'm more concerned about the speed
 * of things"; chose "Reply checker and jobs"). A change's replay runs a fixed part of the two biggest areas, not all
 * of it: an examiner session answers every call by hand, and a full run had grown to about 494 calls (2026-11-15).
 *
 * - review and respond, the two unit steps: `UNIT_LIMIT` cases each (Dev2, 2026-11-15: "these nodes should be cut down
 *   to 20 questions each"), spread over every reviewer set and both kinds of answer, in file order.
 * - jobs: `GATE_JOB_TASKS`, one task of each kind (3 of the 7 whole jobs).
 *
 * The full sets stay in the repository and run whole without `--gate-sample` (`pnpm ai review`, `pnpm ai jobs`).
 * Held-out cases always run whole. A case the change adds or edits always runs too, so a change still passes the
 * case that proves it (docs/decisions/testing/replay-gate.md). No imports, so the gate and the scorers share it freely.
 */

/** How many cases a unit step (the reply reviewer, Decide) runs on a change. */
export const UNIT_LIMIT = 20;

/** Round robin over `buckets` (lists in order), one from each a round, until `limit` are taken. */
export function spread(buckets, limit) {
  const taken = [];
  for (let round = 0; taken.length < limit && buckets.some((list) => round < list.length); round += 1) {
    for (const list of buckets) if (round < list.length && taken.length < limit) taken.push(list[round]);
  }
  return taken;
}

/** One list's faults and good replies alternating, starting with a fault or a good one. */
const alternate = (cases, faultFirst) => {
  const [a, b] = faultFirst ? [cases.filter((c) => c.fault), cases.filter((c) => !c.fault)] : [cases.filter((c) => !c.fault), cases.filter((c) => c.fault)];
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter(Boolean);
};

/** The job tasks a change's replay runs: one research page, one page edit, one errand. */
export const GATE_JOB_TASKS = ["research-caterers-page", "page-edit-fix-caterer-numbers", "errand-register-retreat-and-note"];

/** Ids of `cases` that are new or changed against `baseCases` (main's copy; an id main lacks is new). */
export function changedIds(cases, baseCases) {
  const base = new Map((baseCases ?? []).map((item) => [item.id, JSON.stringify(item)]));
  return new Set(cases.filter((item) => base.get(item.id) !== JSON.stringify(item)).map((item) => item.id));
}

/** The reviewer cases a change's replay runs, from `{ [set]: cases }` and main's sets, as a set of ids. */
export function reviewSample(sets, baseSets) {
  // Every set gives one case before any gives two, and neighbouring sets start on opposite kinds, so the sample is
  // about half faults and half good replies.
  const buckets = Object.keys(sets).sort().map((name, i) => alternate(sets[name], i % 2 === 0));
  const keep = new Set(spread(buckets, UNIT_LIMIT).map((item) => item.id));
  for (const id of changedIds(Object.values(sets).flat(), Object.values(baseSets ?? {}).flat())) keep.add(id);
  return keep;
}

/** Decide's cases a change's replay runs (the "@Tex must still work" set, other replies, quiet ones in turn), as ids. */
export function respondSample(cases, baseCases) {
  const buckets = [cases.filter((c) => c.want !== "hush" && c.must), cases.filter((c) => c.want === "hush"), cases.filter((c) => c.want !== "hush" && !c.must)];
  const keep = new Set(spread(buckets, UNIT_LIMIT).map((item) => item.id));
  for (const id of changedIds(cases, baseCases)) keep.add(id);
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
