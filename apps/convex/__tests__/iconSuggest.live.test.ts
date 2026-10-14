/**
 * THE SUGGESTED ICON, AGAINST THE REAL MODEL.
 *
 * `iconSuggest.test.ts` proves the questions with a stand-in model. This asks
 * the deployed inference Worker, so Clef itself, about real folder and note
 * names, and prints what it would suggest for each, so a person can read the
 * list in the job log and judge it. It fails only when a name gets no
 * suggestion at all or the Worker refuses a request.
 *
 * Skipped unless ORGANIZER_LIVE_URL and ORGANIZER_LIVE_SECRET are set, as the
 * "Organizer Eval (live)" workflow sets them. Only invented names are sent;
 * a run is three requests a name.
 */

import { describe, expect, test } from "vitest";
import { suggestIconFor } from "@context/shared/src/iconSuggest";
import { deployedWorker } from "./organizerEval/sweep.helpers";

const url = process.env.ORGANIZER_LIVE_URL ?? "";
const secret = process.env.ORGANIZER_LIVE_SECRET ?? "";

const NAMES = [
  "tex/routines/once",
  "tex/routines",
  "tex",
  "0-inbox/calendar",
  "1-projects/Bible study",
  "2-areas/taxes",
  "1-projects/walnut-credenza.md",
  "3-resources/recipes",
  "1-projects/wedding planning",
  "2-areas/kids school",
  "1-projects/Q4 budget.md",
  "3-resources/japan trip",
  "2-areas/gym",
  "1-projects/podcast",
];

describe.skipIf(url === "" || secret === "")("the suggested icon, live", () => {
  test("every real name gets an emoji from the whole set", async () => {
    const worker = deployedWorker(url, secret);
    const refusals: string[] = [];
    const results = await Promise.all(
      NAMES.map(async (name) => {
        const started = Date.now();
        const icon = await suggestIconFor(name, async (request) => {
          const { answers, status } = await worker(request);
          if (answers === null) refusals.push(`${name}: ${status}`);
          return answers;
        });
        return { name, icon, ms: Date.now() - started };
      }),
    );
    for (const { name, icon, ms } of results) console.log(`${icon ?? "(none)"}  ${name}  ${ms}ms`);
    expect(refusals, "the Worker refused or failed these requests").toEqual([]);
    expect(results.filter((one) => one.icon === null).map((one) => one.name)).toEqual([]);
  }, 180_000);
});
