// `must email`, `must send email` and `must calendar` (`bench/checks.mjs`): what Tex did to the person's mail and
// calendar, read from the run's record, both live and from a result note read back (`report.mjs` `Emails:` line,
// `resultNote.mjs`). The everyday tasks (`ai/tests/everyday.md`) are graded on these, never on what Tex said it did.
import { test } from "node:test";
import assert from "node:assert/strict";

import { calendarChanges } from "../calendar.mjs";
import { calendarTarget, checkVerdicts, emailTarget, readCheck } from "../checks.mjs";
import { resultMarkdown } from "../report.mjs";
import { parseResult } from "../resultNote.mjs";
import { YES_TO_OFFERS, parseTest, personBrief } from "../load.mjs";
import { personText } from "../models.mjs";
import { askerMailOf } from "../groupChat.mjs";
import { readFileSync } from "node:fs";

const grade = (lines, answer) => checkVerdicts({ checks: lines.map(readCheck) }, { tools: [], browser: [], changes: [], emails: [], ...answer }).map((v) => v.pass);

const draft = { to: ["Jo Park <jo@example.com>"], cc: [], subject: "Re: Saturday", replyTo: "19a2f0c4", draft: true };
const sent = { to: ["jo@example.com"], cc: ["ana@example.com"], subject: "Saturday", draft: false };

test("an email check reads its address and the thread it answers, and refuses anything else", () => {
  assert.deepEqual(emailTarget("Jo@Example.com"), { to: "jo@example.com", replyTo: null });
  assert.deepEqual(emailTarget("jo@example.com replying to 19a2f0c4"), { to: "jo@example.com", replyTo: "19a2f0c4" });
  assert.equal(readCheck("- must send email: jo@example.com").what, "send email");
  assert.throws(() => readCheck("- must email: Jo"), /not "<address>"/);
});

test("a draft to the address in its thread passes email, never send email", () => {
  assert.deepEqual(grade(["- must email: jo@example.com replying to 19a2f0c4", "- must send email: jo@example.com"], { emails: [draft] }), [true, false]);
});

test("a new email to the address fails the thread it should have answered", () => {
  assert.deepEqual(grade(["- must email: jo@example.com replying to 19a2f0c4", "- must email: jo@example.com"], { emails: [{ ...draft, replyTo: undefined }] }), [false, true]);
});

test("a send counts for Cc, and must not email catches any email to the address", () => {
  assert.deepEqual(grade(["- must send email: ana@example.com", "- must not email: jo@example.com", "- must not email: sam@example.com"], { emails: [sent] }), [true, false, true]);
});

test("nothing saved or sent fails an email check", () => {
  assert.deepEqual(grade(["- must email: jo@example.com"], {}), [false]);
});

test("a calendar check reads its verb, title words and new start, and refuses anything else", () => {
  assert.deepEqual(calendarTarget('move "dinner with Ana" to 2026-10-21 19:00'), { verb: "move", title: "dinner with ana", day: "2026-10-21", time: "19:00" });
  assert.deepEqual(calendarTarget('cancel "Dentist"'), { verb: "cancel", title: "dentist", day: null, time: null });
  assert.throws(() => readCheck("- must calendar: move dinner"), /not 'add\|move/);
});

const calls = [
  { change: { action: "move", title: "Dinner with Ana", start: "2026-10-21T18:00:00-04:00", new_start: "2026-10-21T19:00:00-04:00" }, check: false, answer: { ok: true } },
  { change: { action: "create", title: "Haircut", start: "2026-10-22T10:30:00-04:00" }, check: false, answer: { ok: true } },
  { change: { action: "cancel", title: "Gym" }, check: true, answer: { ok: true } },
  { change: { action: "cancel", title: "Yoga" }, check: false, answer: { ok: false, refused: "has_guests" } },
];

test("a calendar change that went through passes on its verb, title and start; a check or a refusal changed nothing", () => {
  const changes = calendarChanges(calls);
  assert.deepEqual(
    grade(
      [
        '- must calendar: move "dinner with ana" to 2026-10-21 19:00',
        '- must calendar: move "dinner with ana" to 2026-10-21 18:00',
        '- must calendar: move "dinner" to 2026-10-21',
        '- must calendar: add "haircut" at 2026-10-22 10:30',
        '- must calendar: cancel "gym"',
        '- must calendar: cancel "yoga"',
        '- must not calendar: cancel "dinner"',
      ],
      { changes },
    ),
    [true, false, true, true, false, false, true],
  );
});

test("the email and calendar checks grade the same from a result note the run wrote and the judge read back", () => {
  const run = {
    setup: "production",
    question: 1,
    questionText: "Ask Jo about Saturday",
    as: "Maya",
    kind: "task",
    gate: true,
    run: 1,
    conversation: [
      { from: "person", text: "ask jo about saturday" },
      { from: "assistant", text: "Drafted it." },
    ],
    tools: [],
    changes: calendarChanges(calls),
    emails: [{ ...draft, body: "Can we bring a cake?" }],
  };
  const note = resultMarkdown({ job: "texting-assistant", test: "everyday", testVersion: "1", date: "2026-11-26", commit: "abc", setups: [{ name: "production", version: 1, model: "m" }], runs: [run] });
  const [answer] = parseResult(note).answers;
  const lines = ["- must email: jo@example.com replying to 19a2f0c4 containing a cake | cakes", '- must calendar: move "dinner with ana" to 2026-10-21 19:00', "- must say: drafted", "- must not say: sent it"];
  assert.deepEqual(checkVerdicts({ checks: lines.map(readCheck) }, answer).map((v) => v.pass), [true, true, true, true]);
});

test("a say check reads every text Tex sent, never a quiet one, and an email or write check can name words it holds", () => {
  const conversation = [
    { from: "person", text: "what's the total" },
    { from: "assistant", text: "It comes to **$76.80**." },
    { from: "assistant", text: "Leila", silent: true },
  ];
  assert.deepEqual(grade(["- must say: 76.80 | 76.8", "- must not say: 75.80", "- must say: leila"], { conversation }), [true, true, false]);
  assert.deepEqual(grade(["- must send email: events@puttery.example containing cake"], { emails: [{ to: ["events@puttery.example"], subject: "Re: Booking", body: "Could we bring a Cake on Saturday?", draft: false }] }), [true]);
  assert.deepEqual(grade(["- must email: events@puttery.example containing balloons"], { emails: [{ to: ["events@puttery.example"], subject: "Re: Booking", body: "cake", draft: false }] }), [false]);
  const changes = [{ workspace: "lena", path: "study/spanish.md", kind: "written", detail: "ser is for what something is, estar is for how it is" }];
  assert.deepEqual(grade(["- must write: lena/study/spanish.md containing ser is for what something is, estar is for how it is", "- must write: lena/study/spanish.md containing ser and estar"], { changes }), [true, false]);
});

test("a say check reads a time range as its start, whatever end Tex chose", () => {
  const conversation = (text) => [{ from: "assistant", text }];
  const line = ["- must say: 8 pm | 8pm | 8:00 | 20:00"];
  assert.deepEqual(grade(line, { conversation: conversation("Added: Fri Nov 20, 8–11 PM, at 14 Oak Street.") }), [true]);
  assert.deepEqual(grade(line, { conversation: conversation("Fri Nov 20, 8 to 11:30 pm.") }), [true]);
  assert.deepEqual(grade(line, { conversation: conversation("Fri Nov 20, 7–11 pm.") }), [false], "a range starting at 7 is not 8");
});

test("the played person never reads a grading line, and with person_brief: lines never the case's prose", () => {
  const body = 'Monday 10 am clashes, so the answer is 2 pm.\n\n- kind: task\n- person starts: "reply to my landlord"\n- if asked which day: "monday"\n- must say: 2 pm\n- must not: pick 10 am\n- may: mention the dentist\n- must send email: a@b.invalid';
  assert.equal(personBrief(body, { prose: false }), `- person starts: "reply to my landlord"\n- if asked which day: "monday"\n${YES_TO_OFFERS}`);
  assert.match(personBrief(body), /^Monday 10 am clashes/);
  assert.doesNotMatch(personBrief(body), /must|may:|kind:/);
  // The everyday tests read nothing but those lines (sabotage: drop `person_brief: lines` and the prose names answers).
  for (const name of ["everyday", "everyday-groups"]) {
    const { questions } = parseTest(readFileSync(new URL(`../ai/tests/${name}.md`, import.meta.url), "utf8"));
    for (const q of questions) for (const line of q.brief.split("\n")) assert.match(line, /^- (person|if |earlier|@|as:)/, `${name} ${q.n}: ${line}`);
  }
});

test("a group turn names the asker's own Gmail until it is shared, and never on another member's text", () => {
  const group = { key: "g" };
  assert.deepEqual(askerMailOf({ group, asker: true, mailbox: "lena@example.invalid" }), ["lena@example.invalid"]);
  assert.equal(askerMailOf({ group, asker: true, mailbox: "lena@example.invalid", shared: [{ handle: "lena", address: "lena@example.invalid" }] }), null);
  assert.equal(askerMailOf({ group, asker: false, mailbox: "lena@example.invalid" }), null);
  assert.equal(askerMailOf({ group: null, asker: true, mailbox: "lena@example.invalid" }), null);
});

test("a played person's DONE ends the conversation even after reasoning, and nothing else does", () => {
  assert.equal(personText("DONE"), null);
  assert.equal(personText("The brief has no further lines. So per the instructions, reply with exactly DONE. DONE"), null);
  assert.equal(personText(""), null);
  assert.equal(personText("yes go ahead"), "yes go ahead");
  assert.equal(personText("is it DONE yet?"), "is it DONE yet?");
  assert.equal(personText("The assistant asked which time. The brief has no line for it. <text>yes</text>"), "yes");
  assert.equal(personText("Nothing more to say. <text>DONE</text>"), null);
});
