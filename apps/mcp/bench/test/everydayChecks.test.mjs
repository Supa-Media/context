// `must email`, `must send email` and `must calendar` (`bench/checks.mjs`): what Tex did to the person's mail and
// calendar, read from the run's record, both live and from a result note read back (`report.mjs` `Emails:` line,
// `resultNote.mjs`). The everyday tasks (`ai/tests/everyday.md`) are graded on these, never on what Tex said it did.
import { test } from "node:test";
import assert from "node:assert/strict";

import { calendarChanges } from "../calendar.mjs";
import { calendarTarget, checkVerdicts, emailTarget, readCheck } from "../checks.mjs";
import { resultMarkdown } from "../report.mjs";
import { parseResult } from "../resultNote.mjs";

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
  { change: { action: "move", title: "Dinner with Ana", start: "2026-10-21T19:00:00-04:00" }, check: false, answer: { ok: true } },
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
    emails: [{ ...draft, body: "never kept" }],
  };
  const note = resultMarkdown({ job: "texting-assistant", test: "everyday", testVersion: "1", date: "2026-11-26", commit: "abc", setups: [{ name: "production", version: 1, model: "m" }], runs: [run] });
  const [answer] = parseResult(note).answers;
  assert.equal(note.includes("never kept"), false);
  const lines = ["- must email: jo@example.com replying to 19a2f0c4", '- must calendar: move "dinner with ana" to 2026-10-21 19:00'];
  assert.deepEqual(checkVerdicts({ checks: lines.map(readCheck) }, answer).map((v) => v.pass), [true, true]);
});
