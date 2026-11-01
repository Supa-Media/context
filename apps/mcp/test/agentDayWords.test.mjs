/**
 * A DEADLINE'S DAY IS WORKED OUT, NOT GUESSED (a review, 2026-11-01).
 *
 * An hourly routine ran at 2:00 am Eastern on the Sunday an application
 * closed and texted "closes tomorrow night"; the run three hours later
 * corrected itself to "tonight". The clock line already said Sunday, so the
 * day words are now worked out for the model, the small hours are named, an
 * earlier run and earlier texts carry their own local day, and a day word Tex
 * writes into its own notes carries its date, so a note written yesterday
 * cannot say "tomorrow" to a run today.
 *
 * ## Sabotage record (run by hand while writing this)
 *
 *   `localNowPrompt` dropping `dayWordsPrompt`
 *     → "at 2 am on the closing Sunday, the clock line says the deadline is today" fails
 *   `SMALL_HOURS_END` set to 0
 *     → the same test fails (no after-midnight line)
 *   `routineQuestion` stamping "Last time" with toISOString again
 *     → "a routine's last run and recent texts carry their local day" fails
 *   `datedDayWords` without the already-dated lookahead
 *     → "saving the note again keeps the first date" fails (dates stack)
 *   `textingAwareCallTool` not calling `withDatedDayWords`
 *     → "Tex's own notes get dates beside day words; routines and the person's notes don't" fails
 *   `withDatedDayWords` dating every line, not only new ones
 *     → the same test fails (an old "Dentist tomorrow" gets today's date)
 *   `isTexOwnNote` taking routines in again
 *     → the same test fails, and agentRoutine.test.mjs's daily "what's due today" routine is rewritten
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dayWordsPrompt, datedDayWords } from "../src/agent/dayWords.js";
import { localNowPrompt } from "../src/agent/localNow.js";
import { recentTextsSection, routineQuestion } from "../src/agent/routine.js";
import { textingAwareCallTool } from "../src/agent/textingWrites.js";

const NY = "America/New_York";
// Saturday, October 31, 2026, 9:00 pm in New York (EDT).
const SATURDAY_9PM = Date.UTC(2026, 10, 1, 1, 0);
// Sunday, November 1, 2026, 2:00 am in New York: daylight saving ended at 06:00 UTC.
const SUNDAY_2AM = Date.UTC(2026, 10, 1, 7, 0);
// Sunday, November 1, 2026, 5:00 pm in New York (EST).
const SUNDAY_5PM = Date.UTC(2026, 10, 1, 22, 0);

test("at 2 am on the closing Sunday, the clock line says the deadline is today", () => {
  const line = localNowPrompt(SUNDAY_2AM, NY);
  assert.match(line, /It is now Sunday, November 1, 2026, 2:00 am where they are/);
  assert.match(line, /Today is Sunday, November 1: "tonight" is Sunday night, "tomorrow" is Monday, November 2, "yesterday" was Saturday, October 31\./);
  assert.match(line, /It is after midnight, so Saturday is over: something due Sunday is due today .*never "tomorrow"/);
  assert.match(line, /meant the day it was written, except a routine's own instructions, which mean the day it runs/);
});

test("in the evening there is no after-midnight line, and the days still roll over months and years", () => {
  const saturday = dayWordsPrompt(SATURDAY_9PM, NY);
  assert.match(saturday, /Today is Saturday, October 31: "tonight" is Saturday night, "tomorrow" is Sunday, November 1/);
  assert.doesNotMatch(saturday, /after midnight/);
  assert.doesNotMatch(dayWordsPrompt(SUNDAY_5PM, NY), /after midnight/);
  assert.match(dayWordsPrompt(Date.UTC(2026, 11, 31, 18), "UTC"), /"tomorrow" is Friday, January 1, "yesterday" was Wednesday, December 30/);
  assert.match(dayWordsPrompt(Date.UTC(2028, 1, 28, 18), "UTC"), /"tomorrow" is Tuesday, February 29/);
});

test("a note saying 'closes tomorrow' written yesterday reads as tonight today", () => {
  const written = datedDayWords("The a16z form closes tomorrow night at 11:59 pm PT.", SATURDAY_9PM, NY);
  assert.equal(written, "The a16z form closes tomorrow night (Sunday, November 1) at 11:59 pm PT.");
  // The Sunday run reads the routine with that note's words and is told Sunday is today.
  const routine = {
    path: "tex/routines/hourly/finish-three-jobs.md",
    cadence: { unit: "hour", every: 1 },
    settings: {},
    body: written,
  };
  const question = routineQuestion(routine, { now: SUNDAY_2AM, timeZone: NY });
  assert.match(question, /It is now Sun 2026-11-01 02:00 \(America\/New_York\)/);
  assert.match(question, /closes tomorrow night \(Sunday, November 1\)/);
  assert.match(localNowPrompt(SUNDAY_2AM, NY), /Today is Sunday, November 1: "tonight" is Sunday night/);
});

test("saving the note again keeps the first date", () => {
  const once = datedDayWords("Call the bank today. Due tomorrow morning.", SATURDAY_9PM, NY);
  assert.equal(once, "Call the bank today (Saturday, October 31). Due tomorrow morning (Sunday, November 1).");
  assert.equal(datedDayWords(once, SUNDAY_5PM, NY), once, "a later save never moves or stacks a date");
});

test("code, links and a routine's schedule lines keep exactly what was written", () => {
  const note = [
    "---",
    "at: 2026-11-01 9:00 am",
    "on: tomorrow",
    "until: the form closes tomorrow",
    "---",
    "Read https://example.com/today and `tomorrow` first.",
    "```",
    "due tonight",
    "```",
    "Tonight is the deadline.",
  ].join("\n");
  const dated = datedDayWords(note, SATURDAY_9PM, NY).split("\n");
  assert.equal(dated[1], "at: 2026-11-01 9:00 am");
  assert.equal(dated[2], "on: tomorrow", "a schedule line is parsed, so it is never changed");
  assert.equal(dated[3], "until: the form closes tomorrow (Sunday, November 1)");
  assert.equal(dated[5], "Read https://example.com/today and `tomorrow` first.");
  assert.equal(dated[7], "due tonight");
  assert.equal(dated[9], "Tonight (Saturday, October 31) is the deadline.");
  assert.equal(datedDayWords("Tomorrow's deadline, todays typo.", SATURDAY_9PM, NY), "Tomorrow's (Sunday, November 1) deadline, todays typo.");
  assert.equal(datedDayWords("", SATURDAY_9PM, NY), "");
  assert.equal(datedDayWords("Nothing to date.", SATURDAY_9PM, NY), "Nothing to date.");
});

test("a routine's last run and recent texts carry their local day", () => {
  const routine = { path: "tex/routines/hourly/finish-three-jobs.md", cadence: { unit: "hour", every: 1 }, settings: {}, body: "Finish the jobs." };
  const question = routineQuestion(routine, {
    now: SUNDAY_2AM,
    timeZone: NY,
    lastRun: { at: SATURDAY_9PM, outcome: "answered", text: "Due Sunday, Nov 1." },
  });
  // Stamped in UTC, this was "2026-11-01T01:00:00.000Z": Saturday's text dressed as Sunday's.
  assert.match(question, /Last time \(Sat 2026-10-31 21:00\) you answered:/);
  assert.doesNotMatch(question, /T01:00:00/);
  const section = recentTextsSection(
    [
      { role: "user", text: "(Not a text from them. Your routine tex/routines/hourly/finish-three-jobs.md ran on its schedule and you texted them what follows.)", at: SATURDAY_9PM },
      { role: "assistant", text: "The form closes tomorrow night." },
      { role: "user", text: "ok", at: SUNDAY_2AM },
      { role: "assistant", text: "Got it." },
    ],
    routine.path,
    NY,
  );
  assert.match(section, /\(Sat 2026-10-31 21:00\) You \(this routine, an earlier run\): The form closes tomorrow night\./);
  assert.match(section, /\(Sun 2026-11-01 02:00\) Them: ok/);
  assert.match(section, /\(Sun 2026-11-01 02:00\) You: Got it\./);
  assert.doesNotMatch(recentTextsSection([{ role: "user", text: "hi", at: SATURDAY_9PM }], routine.path), /\(Sat/, "no zone, no stamp");
});

test("Tex's own notes get dates beside day words; routines and the person's notes don't", async () => {
  const written = [];
  const notes = new Map([["tex/about-me.md", "Dentist tomorrow at 3."]]);
  const callTool = async (name, args) => {
    if (name === "read_note") {
      const note = notes.get(args.path);
      return note === undefined ? { isError: true, content: [{ type: "text", text: "not found" }] } : { content: [{ type: "text", text: `path: ${args.path}\netag: e1\n\n${note}` }] };
    }
    if (name === "write_note") written.push({ name, args }); // a new routine's write also lists the others
    return { content: [{ type: "text", text: "saved" }] };
  };
  const tools = [{ name: "write_note", inputSchema: { properties: { path: {}, content: {}, context: {}, expected_etag: {} } } }];
  const wrapped = textingAwareCallTool(callTool, tools, { timeZone: NY, now: () => SATURDAY_9PM });
  await wrapped("write_note", { path: "tex/jobs/a16z.md", content: "Closes tomorrow night." });
  await wrapped("write_note", { path: "tex/routines/daily/due.md", content: "---\nat: 7:30 am\n---\nText me what's due today." });
  await wrapped("write_note", { path: "projects/a16z/application.md", content: "Closes tomorrow night." });
  await wrapped("write_note", { path: "tex/jobs/a16z.md", context: "@team", content: "Closes tomorrow night." });
  assert.equal(written[0].args.content, "Closes tomorrow night (Sunday, November 1).");
  assert.equal(written[1].args.content, "---\nat: 7:30 am\n---\nText me what's due today.", "a routine's today is each run's");
  assert.equal(written[2].args.content, "Closes tomorrow night.", "the person's own note keeps their words");
  assert.equal(written[3].args.content, "Closes tomorrow night.", "another workspace's note is not Tex's own");
  await wrapped("write_note", { path: "tex/skills/morning-brief.md", content: "Read today's calendar." });
  await wrapped("write_note", { path: "tex/heartbeat.md", content: "Check what's due today." });
  await wrapped("write_note", { path: "tex/about-me.md", expected_etag: "e1", content: "Dentist tomorrow at 3.\nStarted a new job today." });
  assert.equal(written[4].args.content, "Read today's calendar.", "a skill is run again");
  assert.equal(written[5].args.content, "Check what's due today.", "so are check-in instructions");
  assert.equal(
    written[6].args.content,
    "Dentist tomorrow at 3.\nStarted a new job today (Saturday, October 31).",
    "an edit dates only the line it adds: the old line's tomorrow was another day's",
  );
});
