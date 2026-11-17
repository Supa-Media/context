import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { LIVE_SETTINGS, MAX_MINUTES_BEFORE, cantRun, minutesBefore, checkinMail, dayOf, earlierLines, fdTest, frontFor, groupFor, jobReportRow, runFd, senderOf, sinceTexAnswered, timeOf, zoneOf } from "../bench/setsFd.mjs";
import { clockMs, installClock } from "../bench/clock.mjs";
import { parsePeople, parseTest } from "../bench/load.mjs";
import sets from "../../../packages/shared/src/texSets.cjs";
import { parseSetup } from "../src/agent/production.js";

const BENCH = new URL("../bench/ai", import.meta.url).pathname;
const TREE = new URL("../../..", import.meta.url).pathname;

const conv = (msgs, more = {}) => ({ id: "c1", set: "dev", kind: "one", members: ["Maya"], world: "maya", msgs, ...more });
const chat = conv([
  { id: "m1", who: "Maya", text: "morning" },
  { id: "m2", who: "Tex", tex: true, text: "Morning!" },
  { id: "m3", who: "Maya", kind: "react", to: "m2", text: "❤️" },
  { id: "m4", who: "Maya", kind: "reply", to: "m2", text: "quick one" },
  { id: "m5", who: "Maya", text: "When's my dentist appointment?", labels: { fd: { must: ["say Tuesday, October 13 at 3 pm"], never: ["make up a date"], star: true } } },
]);
const unit = (c, at) => ({ convo: c, at, label: c.msgs[at].labels.fd, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });

test("the chat before a Front door test goes in as it was, texts and replies only, the person's and Tex's", () => {
  assert.deepEqual(earlierLines(chat, 4), [
    { from: "person", text: "morning" },
    { from: "tex", text: "Morning!" },
    { from: "person", text: "quick one" },
  ]);
});

// Production's ledger keeps each text's own time. Sabotage: drop `minutesBefore` from earlierLines, or the
// `- earlier minutes before:` line from fdTest, and the whole chat reads as sent a minute ago.
test("each earlier line is dated by its own day and time, held inside the seven days of verbatim chat", () => {
  const c = conv([
    { id: "m0", who: "Maya", text: "before any date" },
    { id: "m1", who: "Maya", text: "hi", at: "Mon Oct 5 10:00" },
    { id: "m2", tex: true, text: "Hi!", at: "Mon 10:01" },
    { id: "m3", who: "Maya", text: "and now?", at: "Tue 9:00", labels: { fd: { must: ["answers"] } } },
    { id: "m4", who: "Maya", text: "much later", at: "Wed Oct 21 9:00" },
  ]);
  assert.equal(minutesBefore(c, 1, 3, 2026), 23 * 60);
  assert.equal(minutesBefore(c, 2, 3, 2026), 23 * 60 - 1);
  assert.equal(minutesBefore(c, 3, 1, 2026), null, "never dated after the text");
  assert.equal(minutesBefore(c, 1, 4, 2026), MAX_MINUTES_BEFORE, "sixteen days back is held inside six");
  assert.deepEqual(earlierLines(c, 3).map((l) => l.minutesBefore), [undefined, undefined, undefined], "no year, no dates");
  assert.deepEqual(earlierLines(c, 3, 2026).map((l) => l.minutesBefore), [1380, 1380, 1379], "a line before the first date is as old as the next");
  const raw = fdTest([unit(c, 3)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-06\nruns: 1\nweb: scripted");
  assert.deepEqual(parseTest(raw).questions[0].earlier.map((l) => [l.from, l.minutesBefore]), [["person", 1380], ["person", 1380], ["tex", 1379]]);
});

test("a test runs one text with the chat before it and its must and never lines, as the bench parses it", () => {
  const raw = fdTest([unit(chat, 4)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\nruns: 1\nweb: scripted");
  const q = parseTest(raw).questions[0];
  assert.equal(q.texts, "When's my dentist appointment?");
  assert.equal(q.personStarts, null, "one text: nobody plays the person after it");
  assert.equal(q.kind, "task");
  assert.deepEqual(q.must, ["say Tuesday, October 13 at 3 pm"]);
  assert.deepEqual(q.mustNot, ["make up a date"]);
  assert.deepEqual(q.earlier.map((l) => l.from), ["person", "tex", "person"]);
});

test("a person's tests run in their bench world, on its day, once, on the scripted web", async () => {
  const front = await frontFor(BENCH, "Maya");
  assert.match(front, /^run_as: Maya$/m);
  assert.match(front, /^today: 2026-10-08$/m, "the core set's day, which the Maya conversation's facts are on");
  assert.match(front, /^runs: 1$/m);
  assert.match(front, /^web: scripted$/m);
  assert.match(front, /^background: on$/m, "offered background jobs, as every production text is");
  assert.equal(parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`).front.background, "on");
  assert.equal(await frontFor(BENCH, "Nobody Here"), null);
});

test("someone with no test of their own runs on the core set's lines as themselves, on the day and in the group asked", async () => {
  const front = await frontFor(BENCH, "John", { today: "2026-10-13", group: "the-flat" });
  assert.match(front, /^run_as: John$/m);
  assert.match(front, /^group: the-flat$/m);
  assert.match(front, /^today: 2026-10-13$/m);
  assert.match(front, /^every_answer:/m, "the core set's voice lines");
  assert.equal((front.match(/^group: /gm) ?? []).length, 1);
});

test("the bench's people are exactly the people a Dev chat may have", async () => {
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  const withWorld = [...new Set(people.filter((r) => r.personal).map((r) => r.person))].sort();
  assert.deepEqual([...sets.BENCH_PEOPLE].sort(), withWorld);
});

test("a group runs in the shared workspace that has all its members, and each earlier line is its sender's", async () => {
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  const flat = conv([
    { id: "m1", who: "Priya", at: "Sun Jun 28 18:10", text: "who ate my leftover pad thai" },
    { id: "m2", who: "Kofi", text: "three bites" },
    { id: "m3", who: "Routine", via: "routine", at: "Mon 9:30", text: "rent reminder" },
    { id: "m4", who: "Tex", tex: true, text: "Rent's due Wednesday." },
    { id: "m5", who: "John", at: "Wed 8:50", text: "Tex what was the low last night", labels: { fd: { must: ["one number"], star: true } } },
  ], { id: "the-flat", kind: "group", members: ["Priya", "John", "Kofi"] });
  assert.equal(groupFor(people, flat), "the-flat");
  assert.equal(groupFor(people, { ...flat, id: "x", members: ["Maya", "Priya"] }), "band", "the first shared workspace with them all");
  assert.equal(groupFor(people, { ...flat, members: ["Maya", "Remi"] }), null);
  assert.deepEqual(earlierLines(flat, 4), [
    { from: "person", who: "priya", text: "who ate my leftover pad thai" },
    { from: "person", who: "kofi", text: "three bites" },
    { from: "trigger", via: "routine", text: "rent reminder" },
    { from: "tex", text: "Rent's due Wednesday." },
  ], "the routine row is nobody's text: the routine that ran");
  const q = parseTest(fdTest([unit(flat, 4)], "job: texting-assistant\nrun_as: John\ngroup: the-flat\ntoday: 2026-07-01")).questions[0];
  assert.deepEqual(q.earlier.map((l) => l.who ?? l.via ?? l.from), ["priya", "kofi", "routine", "tex"]);
});

test("a job row reports the asker's job, titled from their first sentence, and runs as them; a group's routine runs as its owner", async () => {
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  const wedding = conv([
    { id: "m1", who: "Maya", text: "Can you check my email from Paulo for details? Then the hotel." },
    { id: "m2", who: "Tex", tex: true, text: "On it." },
    { id: "m3", who: "Background job", via: "job", text: "ceremony Sat 4pm", labels: { fd: { must: ["say 4pm"], star: true } } },
    { id: "m4", who: "Background job", via: "job", state: "running", text: "still looking at hotels" },
  ]);
  assert.deepEqual(jobReportRow(wedding, 2), { title: "Can you check my email from Paulo for details?", state: "done", text: "ceremony Sat 4pm", asked: "Can you check my email from Paulo for details? Then the hotel.", askedBy: "Maya" });
  assert.equal(jobReportRow(wedding, 3).state, "running");
  assert.equal(senderOf(wedding, 2), "Maya");
  const q = parseTest(fdTest([unit(wedding, 2)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-07-01")).questions[0];
  assert.equal(q.jobReport.title, "Can you check my email from Paulo for details?");
  assert.equal(q.jobReport.state, "done");
  const later = parseTest(fdTest([unit({ ...wedding, msgs: [...wedding.msgs, { id: "m5", who: "Maya", text: "thanks", labels: { fd: { must: ["be short"], star: true } } }] }, 4)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-07-01")).questions[0];
  assert.deepEqual(later.earlier.filter((l) => l.from === "trigger").map((l) => [l.via, l.report.state]), [["job", "done"], ["job", "running"]], "earlier job reports keep their state");
  const flat = conv([{ id: "m1", who: "Routine", via: "routine", text: "rent" }], { id: "the-flat", kind: "group", members: ["Priya", "John", "Kofi"] });
  assert.equal(senderOf(flat, 0, people, "the-flat"), people.find((r) => r.workspace === "the-flat" && r.role === "owner").person);
});

test("each test's day is walked from the first dated time line", () => {
  const c = conv([
    { id: "m1", who: "Maya", at: "Tue Oct 13 10:14", text: "a" },
    { id: "m2", who: "Maya", at: "Tue 22:58", text: "b" },
    { id: "m3", who: "Maya", at: "Fri 9:36", text: "c" },
    { id: "m4", who: "Maya", text: "d" },
    { id: "m5", who: "Maya", at: "Mon 10:40", text: "e" },
    { id: "m6", who: "Maya", at: "Sat Oct 24 7:15", text: "f" },
  ]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => dayOf(c, i, 2026)), ["2026-10-13", "2026-10-13", "2026-10-16", "2026-10-16", "2026-10-19", "2026-10-24"]);
  assert.equal(dayOf(conv([{ id: "m1", who: "Maya", at: "Tue 9:00", text: "x" }]), 0, 2026), null, "no dated line: the test's own day");
});

test("what can't run says why: a check-in that found no email, a tapback, a picture; a group chat and its check-in and routine rows run", () => {
  assert.equal(cantRun(chat, 4), null);
  assert.equal(cantRun({ ...chat, kind: "group" }, 4), null);
  // A check-in that found an email, a routine and a job's report run, in a group too (`byCode.mjs`).
  assert.equal(cantRun(conv([{ id: "m1", who: "Routine", via: "routine", text: "rent reminder" }]), 0), null);
  assert.equal(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "Gmail: TAP: flight delayed" }]), 0), null);
  assert.match(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "calendar: dentist moved" }]), 0), /found an email/);
  assert.equal(cantRun(conv([{ id: "m1", who: "Routine", via: "routine", text: "rent reminder" }], { kind: "group" }), 0), null);
  assert.equal(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "Gmail: TAP: flight delayed" }], { kind: "group" }), 0), null);
  assert.equal(cantRun(conv([{ id: "m1", who: "Maya", text: "find the venue" }, { id: "m2", who: "Background job", via: "job", text: "venue booked" }]), 1), null);
  assert.match(cantRun(chat, 2), /react/);
  assert.match(cantRun(conv([{ id: "m1", who: "Maya", text: "this?", pics: [{ url: "https://x.test/a.png" }] }]), 0), /pictures/);
});

test("the live setup's settings parse as a texting setup, its models and words from Tex's config", async () => {
  const setup = await parseSetup(`---\n${LIVE_SETTINGS}\n---\n\nTex's rules.\n`);
  assert.ok(setup, "the stand-in setup parses");
  assert.equal(setup.job, "texting-assistant");
  assert.equal(setup.maxSteps, 24);
  assert.ok(setup.prompts?.texts?.length > 0, "the prompt words come from the config");
});

test("the batch runs each person's tests as one bench test and maps each judged case back to its row", async () => {
  const seen = [];
  const runTests = async (tree, tests, { dir, fake }) => {
    seen.push({ tests, fake, setup: await readFile(join(dir, "setups/texting-assistant/production.md"), "utf8"), raw: await readFile(join(dir, "tests", `${tests[0]}.md`), "utf8") });
    return { rows: [{ id: "sets-1/q1", right: true }, { id: "sets-1/q2", right: false }], usd: 0.02, bars: {}, missing: [] };
  };
  const two = conv([...chat.msgs, { id: "m6", who: "Maya", text: "and the plumber?", labels: { fd: { must: ["say Friday"], star: true } } }]);
  const group = { ...two, id: "g1", kind: "group", members: ["Maya", "Remi"] };
  const rows = await runFd([unit(two, 4), unit(two, 5), unit(group, 4)], { tree: TREE, fake: true, runTests });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tests, ["sets-1"]);
  assert.match(seen[0].setup, /max_steps: 24/, "an unpulled tree runs with the live settings");
  assert.equal(parseTest(seen[0].raw).questions.length, 2);
  assert.match(rows[0].why, /no shared workspace .* has all of Maya, Remi/);
  assert.deepEqual(rows.map((r) => [r.chat, r.msg, r.ran, r.right]), [
    ["g1", "m5", false, false],
    ["c1", "m5", true, true],
    ["c1", "m6", true, false],
  ]);
  assert.equal(rows[1].usd, 0.01);
});

test("a case the bench gave no answer for did not run, and the scratch folder is gone after", async () => {
  let scratch = null;
  const runTests = async (_tree, _tests, opts) => {
    scratch = opts.scratch;
    return { rows: [], usd: 0, bars: {}, missing: [] };
  };
  const rows = await runFd([unit(chat, 4)], { tree: TREE, runTests });
  assert.deepEqual(rows.map((r) => [r.ran, r.why]), [[false, "the bench gave no judged answer"]]);
  await assert.rejects(readFile(join(scratch, "ai/tests/sets-1.md")), "nothing of a conversation is left on disk");
});

test("the batch runs through the real bench on fake models end to end", async () => {
  const rows = await runFd([unit(chat, 4)], { tree: TREE, fake: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ran, true, rows[0].why);
});

test("a group chat's test runs through the real bench on fake models end to end, as its sender in its shared workspace", async () => {
  const flat = conv([
    { id: "m1", who: "Priya", at: "Sun Jun 28 18:10", text: "who ate my leftover pad thai" },
    { id: "m2", who: "Kofi", text: "three bites" },
    { id: "m3", who: "John", text: "Tex does the lease say anything about appliances", labels: { fd: { must: ["quote Section 9"], star: true } } },
  ], { id: "the-flat", kind: "group", members: ["Priya", "John", "Kofi"] });
  const rows = await runFd([unit(flat, 2)], { tree: TREE, fake: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ran, true, rows[0].why);
});

test("a check-in row's email: the sender before the first colon, the rest as what it says", () => {
  assert.deepEqual(checkinMail("Gmail: TAP: flight TP 237 delayed 50 minutes, new departure 2:05pm."), { from: "TAP", subject: "flight TP 237 delayed 50 minutes, new departure 2:05pm.", body: "flight TP 237 delayed 50 minutes, new departure 2:05pm." });
  assert.equal(checkinMail("Gmail: no sender here at all").from, "(sender)");
  assert.equal(checkinMail("rent reminder"), null);
});

test("a check-in or routine row becomes its case's start line, not a person's text", () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "hi" },
    { id: "m2", who: "Check-in", via: "checkin", text: "Gmail: TAP: flight delayed", labels: { fd: { must: ["say the delay"], star: true } } },
    { id: "m3", who: "Routine", via: "routine", text: "reminder: meds", labels: { fd: { must: ["short"], star: true } } },
  ]);
  const md = fdTest([{ convo: c, at: 1, label: c.msgs[1].labels.fd }, { convo: c, at: 2, label: c.msgs[2].labels.fd }], "run_as: Maya");
  assert.match(md, /- check-in mail: \{"from":"TAP"/);
  assert.match(md, /- routine runs: "reminder: meds"/);
  assert.doesNotMatch(md, /- person texts: "reminder: meds"/);
  const parsed = parseTest(md).questions;
  assert.deepEqual(parsed[0].checkinMail, { from: "TAP", subject: "flight delayed", body: "flight delayed" });
  assert.equal(parsed[1].routine, "reminder: meds");
});

// Dev set, 2026-11-17: "add it to the calendar" in a chat whose setting gives Tex the calendar was answered "your
// Google Calendar isn't connected", because the bench person's fixture held no calendar days. Sabotage: dropping the
// `calendar: connected` line, or benchCalendar's empty connected calendar, fails this.
test("a conversation whose setting gives Tex the calendar runs with one connected, empty and writable", async () => {
  const { hasCalendar } = await import("../bench/setsFd.mjs");
  const { benchCalendar } = await import("../bench/calendar.mjs");
  assert.equal(hasCalendar({ setting: "Tex has Gmail, Calendar, Context notes and the web." }), true);
  assert.equal(hasCalendar({ setting: "the group's notes, the shared calendar and the web" }), true);
  assert.equal(hasCalendar({ setting: "Tex has the group's notes." }), false);
  const front = await frontFor(BENCH, "John", { today: "2026-10-13", calendar: true });
  assert.match(front, /^calendar: connected$/m);
  assert.equal(parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`).front.calendar, "connected");
  assert.doesNotMatch(await frontFor(BENCH, "John", { today: "2026-10-13" }), /^calendar: /m);
  const connected = benchCalendar([], "John");
  assert.deepEqual(connected.calendarDays({ date: "2026-10-13" }), { ok: true, days: [] });
  assert.equal(connected.calendarAddress, "john@calendar.bench.invalid");
  assert.equal(benchCalendar([], null).calendarDays, null, "none connected unless the test says so");
  const fixture = [{ date: "2026-10-13", address: "j@example.invalid", text: "### 09:00 · Gym" }];
  assert.equal(benchCalendar(fixture, "John").calendarAddress, "j@example.invalid", "a connected fixture calendar takes their changes");
  assert.equal(benchCalendar(fixture, "John").calendarDays({ date: "2026-10-13" }).days.length, 1, "and still reads its own days");
  assert.equal(benchCalendar(fixture, null).calendarAddress, undefined, "a fixture without calendar: connected is kept as it is");
});

test("a Front door row runs at its own time of day in its person's zone, never noon UTC", async () => {
  const c = conv([{ id: "m1", who: "Maya", at: "Fri Oct 23 8:02", text: "a" }, { id: "m2", who: "Tex", tex: true, text: "b" }, { id: "m3", who: "Maya", at: "21:40", text: "c" }]);
  assert.deepEqual([0, 1, 2].map((i) => timeOf(c, i)), ["08:02", "08:02", "21:40"]);
  assert.equal(timeOf(conv([{ id: "m1", who: "Maya", text: "x" }]), 0), null);
  assert.equal(await zoneOf(BENCH, "john"), "America/Chicago", "the zone the person's own calendar names");
  assert.equal(await zoneOf(BENCH, "nobody-here"), "America/New_York", "else the gateway's default");
  assert.equal(new Date(clockMs("2026-10-23", "08:02", "America/Chicago")).toISOString(), "2026-10-23T13:02:00.000Z");
  assert.equal(new Date(clockMs("2026-01-10", "08:02", "America/Chicago")).toISOString(), "2026-01-10T14:02:00.000Z", "winter's offset");
  assert.equal(clockMs("2026-10-23", "8pm", "America/Chicago"), null);
  const restore = installClock("2026-10-23", { stepped: false, at: clockMs("2026-10-23", "08:02", "America/Chicago") });
  try {
    assert.equal(new Date().toISOString().slice(0, 16), "2026-10-23T13:02");
  } finally {
    restore();
  }
  const front = await frontFor(BENCH, "John", { today: "2026-10-23", clock: "08:02" });
  assert.match(front, /^time_zone: America\/Chicago$/m);
  assert.match(front, /^clock: 08:02$/m);
  assert.equal(parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`).front.clock, "08:02");
});

test("a Dev text's pictures go in with it, and an earlier one with its line, when the repository keeps them", () => {
  const url = (name) => `https://raw.githubusercontent.com/Supa-Media/context/main/apps/mcp/bench/ai/pictures/${name}`;
  const c = conv([
    { id: "m1", who: "Maya", text: "", pics: [{ url: url("dev-wedding-rsvp.jpg") }] },
    { id: "m2", who: "Tex", tex: true, text: "Got it." },
    { id: "m3", who: "Maya", text: "this ok?", pics: [{ url: url("dev-passport-page.jpg") }], labels: { fd: { must: ["x"] } } },
  ]);
  assert.deepEqual(earlierLines(c, 2), [{ from: "person", text: "", pictures: ["dev-wedding-rsvp.jpg"] }, { from: "tex", text: "Got it." }]);
  assert.equal(cantRun(c, 2), null);
  assert.equal(cantRun(c, 0), null, "a picture with no words is a text");
  const test = fdTest([unit(c, 2)], "run_as: x");
  assert.match(test, /^- person sends picture: dev-passport-page\.jpg$/m);
  assert.match(test, /^- earlier person: ""\n- earlier person sends picture: dev-wedding-rsvp\.jpg$/m);
  const parsed = parseTest(`---\nrun_as: x\n---\n\n${test.split("---\n").slice(2).join("---\n")}`);
  assert.deepEqual(parsed.questions[0].sendsPictures, ["dev-passport-page.jpg"]);
  assert.deepEqual(parsed.questions[0].earlier[0].pictures, ["dev-wedding-rsvp.jpg"]);
  // A picture nobody answered yet goes in with the text after it, as a turn reads what was sent since Tex last answered.
  const after = conv([
    { id: "m1", who: "Maya", text: "Got the tickets", pics: [{ url: url("dev-flat-notice.jpg") }] },
    { id: "m2", who: "Tex", tex: true, text: "Nice." },
    { id: "m3", who: "Maya", text: "", pics: [{ url: url("dev-airport-signs.jpg") }] },
    { id: "m4", who: "Maya", text: "where do i go", labels: { fd: { must: ["x"] } } },
  ]);
  const sent = fdTest([unit(after, 3)], "run_as: x");
  assert.match(sent, /^- person sends picture: dev-airport-signs\.jpg$/m);
  assert.doesNotMatch(sent, /^- earlier person sends picture: dev-airport-signs\.jpg$/m, "sent once, with the turn");
  assert.match(sent, /^- earlier person sends picture: dev-flat-notice\.jpg$/m, "an answered one stays where it was sent");
  assert.deepEqual(sinceTexAnswered([{ from: "person", text: "a", pictures: ["p.jpg"] }], ["q.jpg"]).unanswered, ["p.jpg", "q.jpg"]);
  const six = ["1", "2", "3", "4", "5", "6"].map((n) => ({ from: "person", who: "kofi", text: "", pictures: [`${n}.jpg`] }));
  assert.deepEqual(sinceTexAnswered(six, [], true).unanswered, ["3.jpg", "4.jpg", "5.jpg", "6.jpg"], "a group turn reads the newest four");
  assert.equal(sinceTexAnswered([...six, ...six, ...six], []).unanswered.length, 8, "a one-to-one turn reads the first eight");
  assert.deepEqual(sinceTexAnswered([six[0], { from: "trigger", via: "routine" }]).unanswered, [], "a routine clears the chat's lines");
  assert.deepEqual(sinceTexAnswered([six[0], { from: "trigger", via: "checkin" }]).unanswered, ["1.jpg"]);
  const elsewhere = conv([{ id: "m1", who: "Maya", text: "hi", pics: [{ url: "https://example.com/a.jpg" }] }]);
  assert.match(cantRun(elsewhere, 0), /isn't kept in the repository/);
});
