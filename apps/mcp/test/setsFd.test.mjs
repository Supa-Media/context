import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { LIVE_SETTINGS, PURE_ACK, burstBefore, cantRun, minutesBefore, checkinMail, dayOf, earlierLines, fdTest, frontFor, groupFor, jobReportRow, runFd, senderOf, sinceTexAnswered, timeOf, zoneOf } from "../bench/setsFd.mjs";
import { REAL_CLEF_ENV } from "../bench/worldAi.mjs";
import { clockMs, installClock } from "../bench/clock.mjs";
import { runPool, scheduleOrder } from "../bench/setsPool.mjs";
import { parsePeople, parseTest } from "../bench/load.mjs";
import sets from "../../../packages/tex/src/texSets.cjs";
import { parseSetup } from "../../../packages/tex/gateway/agent/production.js";

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
    { from: "person", text: '❤️ (yes) on Tex\'s message "Morning!"' },
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
  assert.equal(minutesBefore(c, 1, 4, 2026), 16 * 24 * 60 - 60, "sixteen days less an hour back reads as that, not held at six days");
  assert.deepEqual(earlierLines(c, 3).map((l) => l.minutesBefore), [undefined, undefined, undefined], "no year, no dates");
  assert.deepEqual(earlierLines(c, 3, 2026).map((l) => l.minutesBefore), [1380, 1380, 1379], "a line before the first date is as old as the next");
  const raw = fdTest([unit(c, 3)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-06\nruns: 1\nweb: scripted");
  assert.deepEqual(parseTest(raw).questions[0].earlier.map((l) => [l.from, l.minutesBefore]), [["person", 1380], ["person", 1380], ["tex", 1379]]);
});

// The bench used to hold a line older than six days at six days. The Front door reads seven days word for word and
// production summarises the older days, so a chat spanning weeks reads its real ages now, and `benchDays.mjs` writes
// the days past the window. Sabotage: clamp `minutesBefore` to a cap again.
test("a line weeks back reads its real age, not a cap", () => {
  const c = conv([
    { id: "m0", who: "Maya", text: "the first ask", at: "Mon Sep 14 10:00" },
    { id: "m1", who: "Maya", text: "and now?", at: "Sun Oct 4 10:00", labels: { fd: { must: ["answers"] } } },
  ]);
  assert.equal(minutesBefore(c, 0, 1, 2026), 20 * 24 * 60, "twenty days back is twenty days");
  assert.deepEqual(earlierLines(c, 1, 2026).map((l) => l.minutesBefore), [20 * 24 * 60]);
});

test("a test runs one text with the chat before it and its must and never lines, as the bench parses it", () => {
  const raw = fdTest([unit(chat, 4)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\nruns: 1\nweb: scripted");
  const q = parseTest(raw).questions[0];
  assert.equal(q.texts, "quick one\nWhen's my dentist appointment?", "the text still waiting before it goes with it, as production merges them");
  assert.equal(q.personStarts, null, "one text: nobody plays the person after it");
  assert.equal(q.kind, "task");
  assert.deepEqual(q.must, ["say Tuesday, October 13 at 3 pm"]);
  assert.deepEqual(q.mustNot, ["make up a date"]);
  assert.deepEqual(q.earlier.map((l) => l.from), ["person", "tex", "person"], "Maya's ❤️ on Tex's text is a line of the chat, as production logs it");
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

test("the bench's people are exactly the people a Dev or Training chat may have", async () => {
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  const withWorld = [...new Set(people.filter((r) => r.personal).map((r) => r.person))].sort();
  assert.deepEqual([...sets.BENCH_PEOPLE].sort(), withWorld);
});

test("every Training chat's Front door rows have a world to run in: each member a person, each group a shared workspace", async () => {
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  const dir = join(BENCH, "..", "sets", "training");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json"))) {
    const c = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (!c.msgs.some((m) => m.labels?.fd?.star)) continue;
    for (const member of c.members) assert.ok(people.some((r) => r.person === member && r.personal), `${c.id}: ${member} has a bench world`);
    if (c.kind === "group") assert.ok(groupFor(people, c) !== null, `${c.id} runs in a shared workspace`);
  }
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
  assert.equal(dayOf(conv([{ id: "m1", who: "Maya", at: "Tue 9:00", text: "x" }]), 0, 2026), null, "no dated line and no day to start from: the test's own day");
});

test("a chat that names no date still runs each row on its own weekday, from the bench's day on", () => {
  // The bench's day, 2026-10-08, is a Thursday: a Monday routine that ran on it stayed quiet (Training, 2026-11-18).
  const c = conv([
    { id: "m1", who: "Maya", text: "before any time" },
    { id: "m2", who: "Maya", at: "Thu 15:20", text: "a" },
    { id: "m3", who: "Maya", at: "Fri 07:12", text: "b" },
    { id: "m4", who: "Routine", via: "routine", at: "Mon 09:00", text: "Monday week-ahead" },
    { id: "m5", who: "Maya", at: "Mon 13:22", text: "c" },
    { id: "m6", who: "Maya", at: "Sun 10:00", text: "d" },
  ]);
  const days = [0, 1, 2, 3, 4, 5].map((i) => dayOf(c, i, 2026, "2026-10-08"));
  assert.deepEqual(days, ["2026-10-08", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-12", "2026-10-18"]);
  assert.deepEqual(days.map((d) => new Date(`${d}T00:00:00Z`).getUTCDay()), [4, 4, 5, 1, 1, 0], "Thu, Thu, Fri, Mon, Mon, Sun");
  assert.equal(dayOf(conv([{ id: "m1", who: "Maya", at: "Mon 9:00", text: "x" }]), 0, 2026, "2026-10-08"), "2026-10-12", "the first Monday on or after the bench's day");
});

test("rows before a chat's first dated line are walked back from it, each on its own weekday", () => {
  const c = conv([
    { id: "m1", who: "Maya", at: "Mon 19:15", text: "a" },
    { id: "m2", who: "Maya", at: "Wed 17:30", text: "b" },
    { id: "m3", who: "Maya", at: "Mon 17:18", text: "c" },
    { id: "m4", who: "Maya", at: "Thu Nov 12 14:08", text: "d" },
    { id: "m5", who: "Maya", at: "Fri 8:40", text: "e" },
  ]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => dayOf(c, i, 2026, "2026-10-08")), ["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-12", "2026-11-13"]);
});

test("what can't run says why: a check-in that found no email, a tapback, a picture; a group chat and its check-in and routine rows run", () => {
  assert.equal(cantRun(chat, 4), null);
  assert.equal(cantRun({ ...chat, kind: "group" }, 4), null);
  // A check-in that found an email, a routine and a job's report run, in a group too (`byCode.mjs`).
  assert.equal(cantRun(conv([{ id: "m1", who: "Routine", via: "routine", text: "rent reminder" }]), 0), null);
  assert.equal(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "Gmail: TAP: flight delayed" }]), 0), null);
  // A check-in that names only a calendar runs too: its event goes on the bench calendar (`checkinWorld.test.mjs`). A row
  // naming neither mail nor a calendar still can't run.
  assert.equal(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "calendar: dentist moved" }]), 0), null);
  assert.match(cantRun(conv([{ id: "m1", who: "Check-in", via: "checkin", text: "rent reminder" }]), 0), /names an email/);
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
  assert.match(rows[2].why, /no shared workspace .* has all of Maya, Remi/);
  assert.deepEqual(rows.map((r) => [r.chat, r.msg, r.ran, r.right]), [
    ["c1", "m5", true, true],
    ["c1", "m6", true, false],
    ["g1", "m5", false, false],
  ], "rows come back in their units' order");
  assert.equal(rows[0].usd, 0.01);
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

// Lab run v57nzej7ky4nwymkc5txz7vsd18jfj16 (2026-11-17): every Training Front door row was `ran: false`, "Remi has no
// bench world", and the run read 0/63. Training is cast from the bench now (Seyi, 2026-11-17). Sabotage: rename a
// member of `training/trial-hire.json` or `training/truck-crew.json` to anyone `people.md` doesn't have, and this fails.
test("the repo's Training conversations run their Front door tests through the real bench on fake models, one-to-one and group", async () => {
  const { loadSets } = await import("../bench/sets.mjs");
  const training = (await loadSets()).filter((c) => c.set === "training");
  const first = (id) => {
    const c = training.find((x) => x.id === id);
    const at = sets.unitTests(c).find((t) => t.node === "fd" && cantRun(c, t.at) === null).at;
    return unit(c, at);
  };
  const rows = await runFd([first("trial-hire"), first("truck-crew")], { tree: TREE, fake: true });
  assert.deepEqual(rows.map((r) => [r.chat, r.ran, r.why]), [["trial-hire", true, undefined], ["truck-crew", true, undefined]]);
  // Each texted turn's rounds of its bound reach the row, the gateway's own count (Dev2, 2026-11-18: "prove from traces
  // which Training fd misses are round exhaustion"). Sabotage: drop `roundsField` from the reply (`sendTheReply.js`) and this fails.
  for (const r of rows) {
    assert.ok(Array.isArray(r.rounds) && r.rounds.length > 0, `${r.chat}: its turns' rounds are on the row`);
    for (const t of r.rounds.flat()) assert.ok(Number.isInteger(t.used) && t.used >= 1 && Number.isInteger(t.of) && t.used <= t.of, JSON.stringify(t));
  }
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

// Production answers the texts waiting together as one (`inboxTurn.ts` merged). Sabotage: return [] from burstBefore
// and the earlier ask never reaches the turn.
test("a one-to-one text takes the person's waiting texts before it as one, unless Tex answered or time passed between", () => {
  const c = conv([
    { id: "m0", who: "Maya", text: "flight's late", at: "Mon Oct 5 9:00" },
    { id: "m1", tex: true, text: "Ugh, sorry." },
    { id: "m2", who: "Maya", text: "ok" },
    { id: "m3", who: "Maya", text: "weather at home tomorrow?" },
    { id: "m4", who: "Maya", text: "no tuesday actually", labels: { fd: { must: ["gives Tuesday's weather"] } } },
    { id: "m5", tex: true, kind: "react", to: "m4", text: "👍" },
    { id: "m6", who: "Maya", text: "and lisbon?" },
    { id: "m7", who: "Maya", text: "later", at: "Mon 18:00" },
  ]);
  assert.deepEqual(burstBefore(c, 4), ["weather at home tomorrow?"], "a bare ok stays in the history, as production drops an uncovered one");
  const labelled = conv([{ id: "a", who: "Maya", text: "book it", labels: { fd: { must: ["books"] } } }, { id: "b", who: "Maya", text: "for two" }]);
  assert.deepEqual(burstBefore(labelled, 1), [], "a text labelled for the Front door was a turn of its own");
  assert.deepEqual(burstBefore(c, 6), [], "Tex's tapback answered what came before");
  assert.deepEqual(burstBefore(c, 7), [], "a text sent at a time of its own was not waiting with the one before");
  assert.deepEqual(burstBefore({ ...c, kind: "group" }, 4), [], "a group's turn reads the chat, not a burst");
  const q = parseTest(fdTest([unit(c, 4)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-05\nruns: 1\nweb: scripted")).questions[0];
  assert.equal(q.texts, "weather at home tomorrow?\nno tuesday actually");
  assert.deepEqual(q.earlier.map((l) => l.text), ["flight's late", "Ugh, sorry.", "ok"], "the burst is the turn's text, not its history");
});

test("the bench's bare acknowledgement is production's", async () => {
  const source = await readFile(new URL("../../../packages/tex/worker/inboxTurn.ts", import.meta.url), "utf8");
  assert.equal(/const PURE_ACK = (\/.*\/[a-z]*);/.exec(source)?.[1], String(PURE_ACK));
});
// Tex's tapback that was its whole answer is kept as said, as production keeps it (`tapbackSaidLine`); one beside its
// words stays out. Sabotage: skip every `kind` row in `earlierLines` and the "move it" turn reads as unanswered.
test("a tapback that was Tex's whole answer is an earlier line; one beside its words is not", () => {
  const c = {
    kind: "group",
    msgs: [
      { id: "m0", who: "Ben", text: "lol", labels: { decide: { act: "quiet", also_react: "yes" } } },
      { id: "m0b", who: "Tex", tex: true, kind: "react", to: "m0", text: "😂" },
      { id: "m1", who: "Ana", text: "Tex move the dinner to 8" },
      { id: "m2", who: "Tex", tex: true, kind: "react", to: "m1", text: "🗓️" },
      { id: "m3", who: "Ben", text: "Tex what's on friday" },
      { id: "m4", who: "Tex", tex: true, kind: "react", to: "m3", text: "👀" },
      { id: "m5", who: "Tex", tex: true, text: "Dinner at 8." },
      { id: "m6", who: "Ana", text: "wait no" },
    ],
  };
  assert.deepEqual(
    earlierLines(c, 7).map((l) => [l.from, l.text]),
    [
      ["person", "lol"],
      ["person", "Tex move the dinner to 8"],
      ["tex", "(You texted them nothing and reacted 🗓️ to their text.)"],
      ["person", "Tex what's on friday"],
      ["tex", "Dinner at 8."],
    ],
  );
});

// In a one-to-one chat the Worker keeps a tapback answer as Tex's `reaction` event (`inbox.ts`), so the bench posts it
// as one (`- earlier tex tapback:`), never as a sentence. Sabotage: post the group's said line in a one-to-one chat.
test("a one-to-one tapback answer is an earlier tapback, written and read back as one", async () => {
  const c = { kind: "one", members: ["John"], msgs: [{ id: "m1", who: "John", text: "remind me at 9" }, { id: "m2", who: "Tex", tex: true, kind: "react", to: "m1", text: "⏰" }, { id: "m3", who: "John", text: "thanks" }] };
  assert.deepEqual(earlierLines(c, 2).at(-1), { from: "tex", text: "⏰", tapback: true });
  const front = "run_as: John\ntoday: 2026-10-13";
  const md = fdTest([{ convo: c, at: 2, label: { must: ["x"] } }], front);
  assert.match(md, /- earlier tex tapback: "⏰"/);
  const q = parseTest(md, "sets-1.md").questions[0];
  assert.deepEqual(q.earlier.at(-1), { from: "tex", text: "⏰", tapback: true });
});

// A Tex 🔎 that was its whole answer to a find or search ask started a background job: the Worker picks 🔎 from the
// ask's words (`packages/tex/worker/ackEmoji.ts`), and the Front door's own tapback can't be 🔎 (not in `REACT_EMOJI`). With
// no words of Tex's and no job report after it, the job is still running when the labelled row comes, so the row's
// turn is offered it as production's running list does (`background.js` `runningNow`). Sabotage: drop `runningJobOf`
// from fdTest, and the row reads as if nothing ran.
const jobChat = (between = []) =>
  conv([
    { id: "m1", who: "John", text: "Tex compare the three tortilla places, which one's cheapest for 2000 a week", at: "Tue 9:12" },
    { id: "m2", tex: true, kind: "react", to: "m1", text: "🔎" },
    ...between,
    { id: "m9", who: "Kofi", text: "la estrella tastes the best imo" },
    { id: "m10", who: "Priya", text: "agree but they're pricey", labels: { fd: { must: ["take the taste opinion into the answer"] } } },
  ]);
const runningOf = (c, at = c.msgs.length - 1) => parseTest(fdTest([unit(c, at)], "job: texting-assistant\nrun_as: Priya\ntoday: 2026-11-18\nruns: 1\nweb: scripted")).questions[0].runningJobs;

test("a Tex 🔎 that was its whole answer is a job still running at the row, titled from its ask", () => {
  assert.deepEqual(runningOf(jobChat()), [{ title: "Tex compare the three tortilla places, which one's cheapest for 2000 a week" }]);
});

test("a job is not running once Tex has texted words after its 🔎, or once its report is in the chat", () => {
  const words = { id: "m3", tex: true, text: "Looking into the tortilla places now." };
  assert.deepEqual(runningOf(jobChat([words])), [], "Tex answered in words");
  const report = { id: "m3", who: "Background job", via: "job", state: "done", text: "La Estrella $220 a week, free delivery." };
  assert.deepEqual(runningOf(jobChat([report])), [], "its report came back: an earlier job report, not a running job");
  assert.deepEqual(runningOf(jobChat([{ id: "m3", who: "Kofi", text: "they'll deliver free?" }])), [{ title: "Tex compare the three tortilla places, which one's cheapest for 2000 a week" }], "the people talking is not an answer");
});

test("only a find or search tapback starts a job: a 👍 or a 🔎 beside Tex's words does not", () => {
  const c = jobChat();
  const thumbs = conv([c.msgs[0], { id: "m2", tex: true, kind: "react", to: "m1", text: "👍" }, c.msgs[2], c.msgs[3]]);
  assert.deepEqual(runningOf(thumbs), [], "a thumbs-up is no job");
  assert.deepEqual(runningOf(jobChat([{ id: "m3", tex: true, text: "On it." }])), [], "a tapback beside Tex's words was only an acknowledgement");
});

// The Front door label sits on the job's report row (Dev, 2026-11-18: production delivers a result as its own turn, so
// the gold reply is that turn's). The report names John's ask at m39, the message Tex's on-it line replied under, not
// Priya's line in between. Sabotage: fall back to the last person text, and `asked` becomes Priya's line and this fails.
test("the truck-crew job report row names John's ask, the one Tex's on-it line replied under", async () => {
  const raw = JSON.parse(await readFile(new URL("../bench/sets/training/truck-crew.json", import.meta.url), "utf8"));
  const at = raw.msgs.findIndex((m) => m.id === "m42j");
  assert.ok(at > 0, "the labelled job report row is in the conversation");
  assert.equal(raw.msgs[at].via, "job");
  assert.equal(raw.msgs[at].labels.fd.star, true);
  const row = jobReportRow(raw, at);
  assert.equal(row.askedBy, "John");
  assert.match(row.asked, /^Tex compare the three wholesale tortilla places/);
  assert.equal(row.state, "done");
  assert.match(row.text, /La Estrella \$220 \(free delivery\)/);
  assert.equal(cantRun(raw, at), null);
});

// An older 🔎 job Tex answered in words must not be the tapback of a new job started in words (no tapback). Sabotage:
// drop the bound in jobReportRow's scan and `asked` becomes the old ask (a1), so this fails.
test("a job row with no tapback takes the new ask, not an older tapbacked job Tex already answered", () => {
  const c = {
    msgs: [
      { id: "a1", who: "John", text: "Tex compare the tortilla places" },
      { id: "a2", tex: true, kind: "react", who: "Tex", text: "🔎", to: "a1" },
      { id: "a3", tex: true, who: "Tex", text: "Basically a tie, go with La Estrella." },
      { id: "a4", who: "John", text: "Tex what's the weekend look like" },
      { id: "a5", via: "job", who: "Background job", text: "Sat: generator pickup 7am." },
    ],
  };
  const row = jobReportRow(c, 4);
  assert.equal(row.asked, "Tex what's the weekend look like");
  assert.equal(row.askedBy, "John");
});

// A Training conversation scored in context reads itself as an example only up to its moment (`texTraining.cjs`
// UNTIL_ENV; truck-crew 96, 2026-11-18, quoted message 98). Sabotage: drop `envOf` in runConvo, or cut every test at
// the conversation's first unit, and this fails.
test("each test is cut at its own moment: units in one test at their earliest, held out none", async () => {
  const fd = (text, at) => ({ id: `t${at}`, who: "Maya", text, at, labels: { fd: { must: ["answer"], star: true } } });
  const c = conv([...chat.msgs.slice(0, 4), fd("first ask", "Mon 9:00"), fd("second ask", "Mon 9:00"), { id: "t6", who: "Tex", tex: true, text: "ok" }, fd("later ask", "Mon 15:30")], { id: "c9", set: "training" });
  const seen = [];
  const runTests = async (_tree, tests, opts) => {
    for (const t of tests) seen.push([t, opts.envOf?.(t)?.TEX_TRAINING_UNTIL ?? null]);
    return { rows: [], usd: 0, bars: {}, missing: [] };
  };
  await runFd([unit(c, 4), unit(c, 5), unit(c, 7)], { tree: TREE, fake: true, runTests, env: {} });
  assert.deepEqual(seen, [["sets-1", "c9:4"], ["sets-2", "c9:7"]]);
  seen.length = 0;
  await runFd([unit(c, 4), unit(c, 7)], { tree: TREE, fake: true, runTests, holdOut: true, env: {} });
  assert.deepEqual(seen.map(([, cut]) => cut), [null, null], "a held-out chat is dropped whole, never cut");
  seen.length = 0;
  await runFd([unit({ ...c, set: "dev" }, 4)], { tree: TREE, fake: true, runTests, env: {} });
  assert.deepEqual(seen.map(([, cut]) => cut), [null], "a Dev chat is never an example");
});

test("runFd asks the tree's run for real Clef unless fake (worldAi.mjs: the stand-in made every live pick none)", async () => {
  const fd = (text, at) => ({ id: `t${at}`, who: "Maya", text, at, labels: { fd: { must: ["answer"], star: true } } });
  const c = conv([...chat.msgs.slice(0, 4), fd("first ask", "Mon 9:00")], { id: "c10", set: "dev" });
  const seen = [];
  const runTests = async (_tree, tests, opts) => {
    for (const t of tests) seen.push((opts.envOf?.(t) ?? opts.env)?.[REAL_CLEF_ENV] ?? null);
    return { rows: [], usd: 0, bars: {}, missing: [] };
  };
  await runFd([unit(c, 4)], { tree: TREE, runTests, env: {} });
  await runFd([unit(c, 4)], { tree: TREE, fake: true, runTests, env: {} });
  assert.deepEqual(seen, ["1", null]);
});

// The Front door's pool (`setsFd.mjs` runFd): one pool of `parallel` lanes over every test of every conversation, not a
// slice of it per conversation. Each conversation here has one test a day, so every test is one unit. Sabotage: give
// each conversation its own `parallel / conversations` lanes again, and the peak is five, not eight.
const manyDays = (id, n, more = {}) => conv(Array.from({ length: n }, (_, k) => ({ id: `${id}-m${k + 1}`, who: "Maya", text: `ask ${k + 1}`, at: `Oct ${k + 1} 9:00`, labels: { fd: { must: ["answer"] } } })), { id, ...more });
const unitsOf = (c) => c.msgs.map((_, at) => unit(c, at));
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

test("the pool keeps all eight lanes busy across conversations of 17, 13, 11, 11 and 11 tests, and never runs more", async () => {
  const convos = [17, 13, 11, 11, 11].map((n, k) => manyDays(`p${k + 1}`, n));
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const runTests = async (_tree, tests) => {
    calls += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await pause();
    inFlight -= 1;
    return { rows: [{ id: `${tests[0]}/q1`, right: true }], usd: 0, bars: {}, missing: [] };
  };
  const rows = await runFd(convos.flatMap(unitsOf), { tree: TREE, fake: true, runTests, parallel: 8, env: {} });
  assert.equal(calls, 63, "every test ran once");
  assert.equal(peak, 8, "all eight lanes went at once");
  assert.equal(rows.length, 63);
  assert.ok(rows.every((r) => r.ran), "every unit answered");
});

test("tests of one conversation overlap in time, not one after another", async () => {
  const convos = [manyDays("q1", 4), manyDays("q2", 4)];
  const busy = new Map();
  let overlap = 0;
  const runTests = async (_tree, tests, { dir }) => {
    busy.set(dir, (busy.get(dir) ?? 0) + 1);
    overlap = Math.max(overlap, busy.get(dir));
    await pause();
    busy.set(dir, busy.get(dir) - 1);
    return { rows: [{ id: `${tests[0]}/q1`, right: true }], usd: 0, bars: {}, missing: [] };
  };
  await runFd(convos.flatMap(unitsOf), { tree: TREE, fake: true, runTests, parallel: 8, env: {} });
  assert.ok(overlap >= 2, `two tests of one conversation in flight together (peak ${overlap})`);
});

test("rows come back in the units' order, each with the fields a row had before", async () => {
  const c1 = manyDays("o1", 3);
  const c2 = manyDays("o2", 2);
  const units = [unit(c2, 1), unit(c1, 2), unit(c1, 0), unit(c2, 0)];
  const runTests = async (_tree, tests) => ({ rows: [{ id: `${tests[0]}/q1`, right: true, misses: [], held: [{ kind: "must", line: "answer", reason: "yes" }], said: ["Hi"] }], usd: 0.004, bars: {}, missing: [] });
  const rows = await runFd(units, { tree: TREE, fake: true, runTests, parallel: 8, env: {} });
  assert.deepEqual(rows.map((r) => [r.chat, r.msg]), units.map((u) => [u.row.chat, u.row.msg]));
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["at", "chat", "got", "held", "misses", "msg", "node", "ran", "right", "said", "usd", "want", "world"].sort());
    // `world`: the simulated calls no fixture answered (`simFixtures.mjs`); none here, since no test asked the world.
    assert.deepEqual(r.world, { misses: 0, calls: [] });
    assert.equal(r.ran, true);
    assert.equal(r.got, "every line held");
    assert.equal(r.want, "every must and never line");
  }
  // Each conversation's two tests cost 0.004 each: 0.008 over its two units, 0.004 a unit.
  assert.deepEqual(rows.map((r) => r.usd), [0.004, 0.004, 0.004, 0.004]);
});

test("one test that throws marks only its own units could not run; the rest of its conversation still answers", async () => {
  const a = manyDays("f1", 2);
  const b = manyDays("f2", 2);
  const runTests = async (_tree, tests, { dir }) => {
    if (tests[0] === "sets-1" && dir.endsWith(join("c2-f2", "ai"))) throw new Error("the bench fell over");
    return { rows: [{ id: `${tests[0]}/q1`, right: true }], usd: 0, bars: {}, missing: [] };
  };
  const rows = await runFd([...unitsOf(a), ...unitsOf(b)], { tree: TREE, fake: true, runTests, parallel: 8, env: {} });
  const failed = rows.filter((r) => !r.ran);
  assert.deepEqual(failed.map((r) => [r.chat, r.msg, r.why]), [["f2", "f2-m1", "could not run: the bench fell over"]]);
  assert.equal(rows.filter((r) => r.ran).length, 3, "the other three units answered");
});

test("each test's cut reaches its own environment through the pool", async () => {
  const fd = (text, at) => ({ id: `t${at}`, who: "Maya", text, at, labels: { fd: { must: ["answer"], star: true } } });
  const c = conv([...chat.msgs.slice(0, 4), fd("first", "Oct 1 9:00"), fd("second", "Oct 2 9:00"), fd("third", "Oct 3 9:00")], { id: "c9", set: "training" });
  const seen = [];
  const runTests = async (_tree, tests, opts) => {
    seen.push(opts.envOf(tests[0])?.TEX_TRAINING_UNTIL ?? null);
    return { rows: [], usd: 0, bars: {}, missing: [] };
  };
  await runFd([unit(c, 4), unit(c, 5), unit(c, 6)], { tree: TREE, fake: true, runTests, parallel: 8, env: {} });
  assert.deepEqual(seen.sort(), ["c9:4", "c9:5", "c9:6"]);
});

test("the schedule starts the longest conversations first and deals their tests round-robin", () => {
  assert.deepEqual(scheduleOrder([["A0", "A1", "A2"], ["B0"], ["C0", "C1"]]), ["A0", "C0", "B0", "A1", "C1", "A2"]);
  assert.deepEqual(scheduleOrder([["x0", "x1"], ["y0", "y1"]]), ["x0", "y0", "x1", "y1"], "equal lengths keep the input's order");
  assert.deepEqual(scheduleOrder([[], ["z0"]]), ["z0"]);
  assert.deepEqual(scheduleOrder([]), []);
});

test("the pool runs every item, never more than its lanes at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const done = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await pause();
    inFlight -= 1;
    done.push(n);
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});

// gw Lab runs, 2026-11-18: every Claude call failed for lack of credit, one test after another, and the reason was cut
// to the command line. Sabotage: drop the `spent` check in setsPool.mjs untilOutOfCredit, or slice the reason to 200, and this fails.
test("out of credit, the first test's reason reaches its row, and no later test is sent", async () => {
  const reason = "judge failed: judge call for question 1 failed: status 400 (Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.)";
  const sent = [];
  const runTests = async (_tree, tests) => {
    sent.push(tests[0]);
    throw new Error(reason);
  };
  const others = ["c2", "c3"].map((id) => conv(chat.msgs, { id }));
  const rows = await runFd([unit(chat, 4), ...others.map((c) => unit(c, 4))], { tree: TREE, runTests, parallel: 1 });
  assert.equal(sent.length, 1, "only the first test is sent");
  assert.deepEqual(rows.map((r) => [r.chat, r.ran]), [["c1", false], ["c2", false], ["c3", false]]);
  for (const r of rows) assert.equal(r.why, `could not run: ${reason}`.slice(0, "could not run: ".length + 300));
  assert.match(rows[2].why, /credit balance is too low/);
  // Not credit: each test is still sent and fails on its own.
  sent.length = 0;
  await runFd([unit(chat, 4), ...others.map((c) => unit(c, 4))], { tree: TREE, parallel: 1, runTests: async (_t, tests) => { sent.push(tests[0]); throw new Error("answer failed: status 500"); } });
  assert.equal(sent.length, 3);
});
