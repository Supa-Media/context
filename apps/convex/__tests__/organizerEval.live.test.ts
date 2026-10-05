/**
 * THE ORGANIZATION SCORE, AGAINST THE REAL MODEL.
 *
 * `organizerEval.test.ts` proves the sweep with a stand-in model. This runs the
 * same messy workspace through the deployed inference Worker, so Clef itself
 * answers every question, and asks for the same bar: 90% or better.
 *
 * Skipped unless ORGANIZER_LIVE_URL and ORGANIZER_LIVE_SECRET are set (the
 * Worker's address and shared secret). The "Organizer Eval (live)" workflow
 * sets them from the production environment. The workspace is invented, so no
 * customer's note is ever sent; a run costs a few dozen decisions.
 */

import { describe, expect, test } from "vitest";
import { messyWorkspace, misses, organizationScore } from "./organizerEval/workspace.helpers";
import { deployedWorker, runSweep } from "./organizerEval/sweep.helpers";

const url = process.env.ORGANIZER_LIVE_URL ?? "";
const secret = process.env.ORGANIZER_LIVE_SECRET ?? "";
const PASS = Number(process.env.ORGANIZER_LIVE_PASS ?? "0.9");

describe.skipIf(url === "" || secret === "")("the organization score, live", () => {
  test(`a sweep with the real model organizes the messy workspace to ${Math.round(PASS * 100)}% or better`, async () => {
    const { store } = messyWorkspace();
    const before = organizationScore(store.snapshot()).score;
    const report = await runSweep(store, deployedWorker(url, secret));
    const { score, items } = organizationScore(store.snapshot());
    // The run's own summary, in the job log: the number, then every miss.
    console.log(
      JSON.stringify({ before, after: score, asked: report.asked, answered: report.answered, refusals: report.refusals, suggestions: report.suggestions.length }),
    );
    console.log(misses(items) || "no misses");
    expect(report.refusals, "the Worker refused or failed these requests").toEqual([]);
    expect(score, misses(items)).toBeGreaterThanOrEqual(PASS);
  }, 180_000);
});
