/**
 * orient counts and ranks a sheet like a note (`src/orient/survey.js`,
 * `docs/decisions/file-kinds.md`): an agent that is never told a sheet exists
 * cannot open it. A picture is still not counted, a front note is still
 * Markdown, and a team connection is told nothing about a private sheet.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `surveyContext` back on `isVisibleNote`: "a sheet is counted and ranked" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { surveyContext } from "../src/orient/survey.js";

const at = (minute) => new Date(Date.UTC(2026, 10, 25, 1, minute));
const store = (keys) => ({ treeEntries: async () => keys.map(([key, minute]) => ({ key, uploaded: at(minute), size: 1 })) });
const RULES = [{ prefix: "areas/private", vis: "private" }, { prefix: "areas", vis: "team" }];

test("a sheet is counted and ranked among what was touched recently", async () => {
  const survey = await surveyContext(
    store([["areas/metrics/plan.md", 1], ["areas/metrics/readings.csv", 9], ["areas/metrics/photo.png", 10]]),
    "private",
    [],
    new Map(),
  );
  const areas = survey.folders.find((folder) => folder.prefix === "areas/");
  assert.equal(areas.count, 2);
  assert.equal(survey.recent[0].key, "areas/metrics/readings.csv");
  assert.ok(!survey.recent.some(({ key }) => key.endsWith(".png")));
});

test("a team connection is told nothing about a private sheet", async () => {
  const survey = await surveyContext(
    store([["areas/team.md", 1], ["areas/private/payroll.csv", 9]]),
    "team",
    RULES,
    new Map(),
  );
  assert.ok(!survey.recent.some(({ key }) => key.includes("payroll")));
  assert.equal(survey.folders.find((folder) => folder.prefix === "areas/").count, 1);
});
