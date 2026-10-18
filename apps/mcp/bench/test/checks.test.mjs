// `must write` (`bench/checks.mjs`): a note written at a path or under a
// folder, with the front matter a question names, read from the run's record
// both as the live world's change objects and as a result note's lines.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkVerdicts, filedNotes, readCheck, recordedFront, writeTarget } from "../checks.mjs";

const once = "- must write: maya/routines/once/ with at: 2026-10-09 9:00 am";
const weekdays = "- must write: maya/routines/daily/ with at: 7:30 am, on: weekdays";

/** A change as the live world records it (`world.mjs`): the text, whitespace folded. */
const written = (workspace, path, text) => ({ workspace, path, kind: "written", detail: text.replace(/\s+/g, " ").trim() });

const grade = (lines, changes) => checkVerdicts({ checks: lines.map(readCheck) }, { tools: [], browser: [], changes }).map((v) => v.pass);

test("a write check reads its place and the front matter it wants, keeping commas inside a value", () => {
  assert.deepEqual(writeTarget("maya/routines/daily/ with at: 7:30 am, on: mon, wed"), { place: "maya/routines/daily/", front: { at: "7:30 am", on: "mon, wed" } });
  assert.deepEqual(writeTarget("maya/home/apartment-repairs.md"), { place: "maya/home/apartment-repairs.md", front: {} });
  assert.equal(readCheck(once).what, "write");
  assert.equal(readCheck("- must not write: maya/todo.md").kind, "must not");
  assert.throws(() => readCheck("- must write: maya/routines/once/ with 9am"), /not a front matter line/);
});

test("front matter is found in a recorded detail whose line breaks were folded away", () => {
  assert.deepEqual(recordedFront("--- at: 2026-10-09 9:00 am on: 'weekdays' --- Text Maya to call Sam."), { at: "2026-10-09 9:00 am", on: "weekdays" });
  assert.deepEqual(recordedFront("# No front matter: just a note"), {});
});

test("a one-off reminder passes at the right date and time, written any way routines.cjs reads it", () => {
  for (const at of ["2026-10-09 9:00 am", "2026-10-09 9am", "2026-10-09 09:00", "2026-10-09T09:00"]) {
    const note = `---\nat: ${at}\n---\n\nText Maya: call Sam about the venue deposit.\n`;
    assert.deepEqual(grade([once], [written("maya", "routines/once/call-sam.md", note)]), [true], at);
  }
});

test("a one-off reminder fails on the wrong day, the wrong hour, the wrong folder or the wrong workspace", () => {
  const note = (at) => `---\nat: ${at}\n---\n\nCall Sam.\n`;
  assert.deepEqual(grade([once], [written("maya", "routines/once/call-sam.md", note("2026-10-08 9:00 am"))]), [false], "today, not tomorrow");
  assert.deepEqual(grade([once], [written("maya", "routines/once/call-sam.md", note("2026-10-09 9:00 pm"))]), [false], "9 pm");
  assert.deepEqual(grade([once], [written("maya", "routines/once/call-sam.md", note("9:00 am"))]), [false], "no date");
  assert.deepEqual(grade([once], [written("maya", "routines/daily/call-sam.md", note("2026-10-09 9:00 am"))]), [false], "every day");
  assert.deepEqual(grade([once], [written("fashion-brand", "routines/once/call-sam.md", note("2026-10-09 9:00 am"))]), [false], "another workspace");
  assert.deepEqual(grade([once], [{ ...written("maya", "routines/once/call-sam.md", note("2026-10-09 9:00 am")), kind: "proposed" }]), [false], "proposed is not written");
  assert.deepEqual(grade([once], []), [false], "nothing written");
});

test("a weekday routine passes in daily/ or every-day/ with the days in any form, and fails without them", () => {
  const note = (on) => `---\nat: 7:30 am\n${on === null ? "" : `on: ${on}\n`}---\n\nText Maya what's due today.\n`;
  assert.deepEqual(grade([weekdays], [written("maya", "routines/daily/whats-due.md", note("weekdays"))]), [true]);
  assert.deepEqual(grade([weekdays], [written("maya", "routines/every-day/whats-due.md", note("mon, tue, wed, thu, fri"))]), [true]);
  assert.deepEqual(grade([weekdays], [written("maya", "routines/daily/whats-due.md", note(null))]), [false], "every day, weekends too");
  assert.deepEqual(grade([weekdays], [written("maya", "routines/daily/whats-due.md", note("weekends"))]), [false]);
  assert.deepEqual(grade([weekdays], [written("maya", "routines/weekly/whats-due.md", note("weekdays"))]), [false], "weekly");
  assert.deepEqual(grade([weekdays], [written("maya", "routines/daily/whats-due.md", note("weekdays").replace("7:30 am", "7 am"))]), [false], "7:00");
});

// Routines' new home (the owner, 2026-10-14): the core set asks for
// `tex/routines/`, and a write in the old root is in the wrong place.
// Sabotage, 2026-10-14: `atPlace` ignoring which root (`want[2] !== got[2]`
// dropped) fails "the old root is not the new one".
test("a routine check under tex/routines/ passes there, in a folder of the same schedule", () => {
  const texOnce = "- must write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am";
  const texWeekdays = "- must write: maya/tex/routines/daily/ with at: 7:30 am, on: weekdays";
  const reminder = "---\nat: 2026-10-09 9:00 am\n---\n\nText Maya: call Sam.\n";
  const daily = "---\nat: 7:30 am\non: weekdays\n---\n\nText Maya what's due today.\n";
  assert.deepEqual(grade([texOnce], [written("maya", "tex/routines/once/call-sam.md", reminder)]), [true]);
  assert.deepEqual(grade([texWeekdays], [written("maya", "tex/routines/every-day/whats-due.md", daily)]), [true]);
  assert.deepEqual(grade([texOnce], [written("maya", "routines/once/call-sam.md", reminder)]), [false], "the old root is not the new one");
  assert.deepEqual(grade([texWeekdays], [written("maya", "routines/every-day/whats-due.md", daily)]), [false], "the old root is not the new one");
  assert.deepEqual(grade([once], [written("maya", "tex/routines/once/call-sam.md", reminder)]), [false], "nor the new the old");
});

test("an exact path and a must-not write grade the written note alone", () => {
  const lines = ["- must write: maya/home/apartment-repairs.md", "- must not write: maya/todo.md"];
  assert.deepEqual(grade(lines, [written("maya", "home/apartment-repairs.md", "# Apartment repairs\n- Plumber Friday, October 9 at 10 am")]), [true, true]);
  assert.deepEqual(grade(lines, [written("maya", "todo.md", "- [ ] Plumber Friday"), { workspace: "maya", path: "home/apartment-repairs.md", kind: "deleted", detail: "" }]), [false, false]);
});

test("a result note's Changes recorded lines grade the same as the live record", () => {
  // As report.mjs writes them, and resultNote.mjs reads them back.
  const changes = [
    "- written maya/routines/once/call-sam.md: --- at: 2026-10-09 9:00 am --- Text Maya: call Sam about the venue deposit.",
    "- written maya/routines/daily/whats-due.md: --- at: 7:30 am on: weekdays --- Text Maya what's due today.",
    "- deleted maya/todo.md: ",
  ];
  assert.deepEqual(grade([once, weekdays, "- must not write: maya/todo.md"], changes), [true, true, true]);
});

test("a file check grades where housekeeping left a note, what its front matter says and what it holds", () => {
  const lines = [
    "- must file: tomas/1-projects/kitchen/overview.md under tomas/4-archive/",
    "- must file: tomas/todo.md under tomas/todo.md",
    "- must not file: tomas/2-areas/car/insurance.md under tomas/2-areas/car/",
    "- must file: tomas/1-projects/tax/overview.md under tomas/ with status: finished",
    "- must file: tomas/0-inbox/contacts/b/ben-2.md under tomas/0-inbox/contacts/b/ben-2.md with review: *",
    "- must file: tomas/0-inbox/contacts/a/ana.md under tomas/0-inbox/contacts/a/ containing 2026-05-04-note",
  ];
  const where = (map) => checkVerdicts({ checks: lines.map(readCheck) }, { tools: [], browser: [], changes: [], where: map }).map((v) => v.pass);
  const at = (path, front = {}, text = "") => ({ at: path, front, text });
  assert.deepEqual(
    where({
      "tomas/1-projects/kitchen/overview.md": at("tomas/4-archive/1-projects/kitchen/overview.md"),
      "tomas/todo.md": at("tomas/todo.md"),
      "tomas/2-areas/car/insurance.md": at("tomas/2-areas/insurance.md"),
      "tomas/1-projects/tax/overview.md": at("tomas/4-archive/1-projects/tax/overview.md", { status: "Finished" }),
      "tomas/0-inbox/contacts/b/ben-2.md": at("tomas/0-inbox/contacts/b/ben-2.md", { review: "Possible duplicate of ben.md?" }),
      "tomas/0-inbox/contacts/a/ana.md": at("tomas/0-inbox/contacts/a/ana.md", {}, "- [[0-inbox/2026-05-04-note]]"),
    }),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(
    where({
      "tomas/1-projects/kitchen/overview.md": null,
      "tomas/todo.md": at("tomas/inbox/todo.md"),
      "tomas/2-areas/car/insurance.md": at("tomas/2-areas/car/insurance.md"),
      "tomas/1-projects/tax/overview.md": at("tomas/1-projects/tax/overview.md", { status: "in progress" }),
      "tomas/0-inbox/contacts/b/ben-2.md": at("tomas/0-inbox/contacts/b/ben-2.md", {}),
      "tomas/0-inbox/contacts/a/ana.md": at("tomas/0-inbox/contacts/a/ana.md", {}, "Kitchen designer."),
    }),
    [false, false, false, false, false, false],
    "a note gone, moved elsewhere, left where it was, with a stale status, no review, or without the merged link",
  );
  assert.equal(filedNotes({ checks: lines.map(readCheck) }).length, 6);
  assert.throws(() => readCheck("- must file: tomas/todo.md in tomas/x/"), /file check/);
});
