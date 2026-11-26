/**
 * Which areas a Tex nightly runs (`NIGHTLY_ROTATION` in `bench/nightly.mjs`).
 * Invented dates only. The budget check is not this file's job (`spend.test.mjs`).
 *
 * Sabotage: swapping `sunday.even` and `sunday.odd` fails
 * "an even ISO week runs tasks and an odd week runs jobs". Putting web-facts back in `every` before its test file
 * is on main fails "every area a night names has its test files on main".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NIGHTLY_AREAS, NIGHTLY_ROTATION, areasForNight, nightlyAreas } from "../nightly.mjs";

const EVERY = ["respond", "review"];
/** Noon in America/New_York, winter or summer: 17:00 UTC is still that civil date. */
const noon = (iso) => new Date(`${iso}T17:00:00.000Z`);

test("the schedule is one rotation constant", () => {
  assert.deepEqual(NIGHTLY_ROTATION, {
    every: ["respond", "review"],
    monday: ["core"],
    tuesday: ["everyday", "fd-completion"],
    wednesday: ["core"],
    thursday: ["groups", "fd-completion"],
    friday: ["core"],
    sunday: { even: ["tasks"], odd: ["jobs"] },
  });
});

test("every night runs respond and review, core only on Monday, Wednesday and Friday, everyday on Tuesday, groups on Thursday and fd-completion on both", () => {
  const tuesday = [...EVERY, "everyday", "fd-completion"];
  const thursday = [...EVERY, "groups", "fd-completion"];
  assert.deepEqual(areasForNight(noon("2026-11-17")), tuesday, "Tuesday");
  assert.deepEqual(areasForNight(new Date("2026-11-17T07:23:00.000Z")), tuesday, "the 07:23 UTC schedule is still Tuesday in New York");
  assert.deepEqual(areasForNight(noon("2026-11-19")), thursday, "Thursday");
  assert.deepEqual(areasForNight(noon("2026-11-21")), EVERY, "Saturday");
  assert.deepEqual(areasForNight(noon("2026-11-16")), ["core", ...EVERY], "Monday");
  assert.deepEqual(areasForNight(noon("2026-11-18")), ["core", ...EVERY], "Wednesday");
  assert.deepEqual(areasForNight(noon("2026-11-20")), ["core", ...EVERY], "Friday");
  for (const areas of [EVERY, ["core", ...EVERY], tuesday, thursday]) {
    const order = NIGHTLY_AREAS.map((spec) => spec.area);
    assert.deepEqual(areas, order.filter((area) => areas.includes(area)));
  }
});

test("an even ISO week runs tasks and an odd week runs jobs", () => {
  assert.deepEqual(areasForNight(noon("2026-11-15")), ["tasks", ...EVERY], "Sunday 2026-11-15 is ISO week 46");
  assert.deepEqual(areasForNight(noon("2026-11-22")), [...EVERY, "jobs"], "Sunday 2026-11-22 is ISO week 47");
  assert.deepEqual(areasForNight(noon("2026-01-04")), [...EVERY, "jobs"], "Sunday 2026-01-04 is ISO week 1");
  // 2023-01-01 is ISO week 52 of 2022. A day-of-year week would call it week 1 and run jobs.
  assert.deepEqual(areasForNight(noon("2023-01-01")), ["tasks", ...EVERY], "Sunday 2023-01-01 is ISO week 52");
  assert.deepEqual(areasForNight(noon("2027-01-03")), [...EVERY, "jobs"], "Sunday 2027-01-03 is ISO week 53 of 2026");
});

test("the weekday is America/New_York, including across the daylight-saving change", () => {
  // 04:30 UTC on a Monday in winter is 23:30 the Sunday before in New York (EST, UTC-5). A summer offset would already call it Monday.
  assert.deepEqual(areasForNight(new Date("2026-11-16T04:30:00.000Z")), ["tasks", ...EVERY]);
  assert.deepEqual(areasForNight(new Date("2026-11-16T07:23:00.000Z")), ["core", ...EVERY], "07:23 UTC is Monday morning in New York");
  // 03:30 UTC on 1 July is still Tuesday evening in New York (EDT, UTC-4), not Wednesday.
  assert.deepEqual(areasForNight(new Date("2026-07-01T03:30:00.000Z")), [...EVERY, "everyday", "fd-completion"]);
  assert.deepEqual(areasForNight(new Date("2026-07-01T04:00:00.000Z")), ["core", ...EVERY]);
});

test("every area a night names has its test files on main, so no scheduled area reads as not on main yet", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const tests = new URL("../ai/tests/", import.meta.url);
  const named = new Set([NIGHTLY_ROTATION.every, ...Object.values(NIGHTLY_ROTATION).flatMap((v) => (Array.isArray(v) ? [v] : Object.values(v)))].flat());
  for (const area of named) {
    const spec = NIGHTLY_AREAS.find((s) => s.area === area);
    assert.ok(spec, `${area} is a nightly area`);
    for (const test of spec.tests ?? []) await readFile(fileURLToPath(new URL(`${test}.md`, tests)), "utf8");
  }
});

test("a named areas list replaces the rotation, and all runs every area", () => {
  const sunday = noon("2026-11-15");
  assert.deepEqual(nightlyAreas({}, sunday), ["tasks", ...EVERY]);
  assert.deepEqual(nightlyAreas({ areas: "" }, sunday), ["tasks", ...EVERY]);
  assert.deepEqual(nightlyAreas({ areas: "  " }, sunday), ["tasks", ...EVERY]);
  assert.deepEqual(nightlyAreas({ areas: "all" }, sunday), NIGHTLY_AREAS.map((spec) => spec.area));
  assert.deepEqual(nightlyAreas({ areas: "jobs,core" }, sunday), ["core", "jobs"]);
  assert.throws(() => nightlyAreas({ areas: "core,nope" }, sunday), /no nightly area named nope/);
});
