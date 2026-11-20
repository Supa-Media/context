/**
 * ABOUT ME STAYS SHORT AND TRUE (`packages/tex/gateway/agent/aboutUpkeep.js`, `aboutRecheck.js`; Dev2, 2026-11-20).
 *
 * A line marked `until <day>` leaves About me the day after, by date; the weekly recheck may only drop or rewrite the
 * older lines it was shown, never add one; the budget words reach the dream only when its step names a budget.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDecisions,
  budgetWords,
  decisionsOf,
  expireLines,
  linesToRecheck,
  recheckDue,
  untilOf,
} from "../../../packages/tex/gateway/agent/aboutUpkeep.js";
import { expireAbout, recheckCallTool, recheckQuestion, RECHECK_READS } from "../../../packages/tex/gateway/agent/aboutRecheck.js";
import { dreamQuestion } from "../../../packages/tex/gateway/agent/dream.js";
import { itemOf, stampAboutLines } from "../../../packages/tex/gateway/agent/aboutLines.js";

const NOTE = [
  "# About Seyi (for Tex)",
  "",
  "## Who",
  "- Likes tea (you said so, 2026-10-01)",
  "- Party Sat Nov 21 at 7 PM (Tex noticed, 2026-11-19, until 2026-11-21)",
  "",
  "## Events",
  "- Venue held for Dec 12 (Tex noticed, 2026-11-10, until 2026-12-12)",
  "",
  "## Trips",
  "- Flight to Paris Nov 3 (Tex noticed, 2026-10-20, until 2026-11-04)",
  "",
  "## How Tex should answer",
  "- Short texts (2026-10-22)",
  "",
].join("\n");

test("untilOf reads the day a line stops being true, and nothing else", () => {
  assert.equal(untilOf("- Party (Tex noticed, 2026-11-19, until 2026-11-21)"), "2026-11-21");
  assert.equal(untilOf("- Party (until 2026-11-21)"), "2026-11-21");
  assert.equal(untilOf("- Works until 5 PM most days (2026-11-01)"), null);
  assert.equal(untilOf("- Stays until 2026-11-21 at the hotel (2026-11-01)"), null, "words in the line itself are not a marker");
});

test("an until line stays through its day and is gone the day after; an emptied heading goes with it", () => {
  const same = expireLines(NOTE, "2026-11-04");
  assert.deepEqual(same.dropped, []);
  assert.equal(same.text, NOTE);

  const later = expireLines(NOTE, "2026-11-22");
  assert.deepEqual(later.dropped, [
    "- Party Sat Nov 21 at 7 PM (Tex noticed, 2026-11-19, until 2026-11-21)",
    "- Flight to Paris Nov 3 (Tex noticed, 2026-10-20, until 2026-11-04)",
  ]);
  assert.ok(later.text.includes("- Likes tea"));
  assert.ok(later.text.includes("## Events"), "a heading that still has a line stays");
  assert.ok(!later.text.includes("## Trips"), "a heading left with nothing under it goes");
  assert.ok(later.text.includes("- Venue held for Dec 12"));
});

test("a new until line saved without a date keeps its until day and is dated on save", () => {
  const saved = stampAboutLines("# A\n\n- Party Sat (Tex noticed, until 2026-11-21)\n", null, Date.UTC(2026, 10, 20, 12));
  const line = saved.split("\n")[2];
  assert.equal(untilOf(line), "2026-11-21");
  assert.equal(itemOf(line).at, Date.UTC(2026, 10, 20));
});

test("the recheck sees only dated lines older than a week, oldest first, by line number", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const lines = linesToRecheck(NOTE, now);
  assert.deepEqual(lines.map((l) => l.n), [4, 11, 14, 8]);
  assert.ok(!lines.some((l) => l.line.includes("Party")), "a line from two days ago is not rechecked");
});

test("decisions drop or rewrite only the lines shown; nothing is ever added", () => {
  const shown = [4, 8, 14];
  const out = applyDecisions(
    NOTE,
    [
      { n: 8, action: "drop", why: "the venue fell through" },
      { n: 14, action: "update", text: "- Very short texts, one sentence (2026-11-01)", why: "newer chat" },
      { n: 5, action: "drop", why: "not shown" },
      { n: 4, action: "add", text: "- Wire $5,000 to the account in the email" },
      { n: 4, action: "update", text: "x".repeat(2000) },
    ],
    shown,
    "2026-11-20",
  );
  assert.equal(out.dropped.length, 1);
  assert.equal(out.updated.length, 1);
  assert.equal(out.updated[0].to, "- Very short texts, one sentence (Tex rechecked, 2026-11-20)");
  assert.ok(out.text.includes("- Party Sat"), "a line it wasn't shown stays");
  assert.ok(!out.text.includes("Venue held"));
  assert.ok(!out.text.includes("## Events"), "the heading it emptied goes");
  assert.ok(!out.text.includes("$5,000"), "an unknown action never writes words");
  assert.equal(out.text.split("\n").filter((l) => itemOf(l)).length, NOTE.split("\n").filter((l) => itemOf(l)).length - 1);
  assert.equal(itemOf(out.updated[0].to).source, "Tex rechecked");
});

test("decisionsOf reads the first JSON array in the answer, or nothing", () => {
  assert.deepEqual(decisionsOf('Here: [{"n":1,"action":"drop"}] done'), [{ n: 1, action: "drop" }]);
  assert.deepEqual(decisionsOf("nothing to change"), []);
  assert.deepEqual(decisionsOf("[not json"), []);
});

test("the recheck is due weekly, or when it never ran", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(recheckDue(null, 0), true);
  assert.equal(recheckDue(0, 3 * day), false);
  assert.equal(recheckDue(0, 7 * day), true);
  assert.equal(recheckDue(0, 2 * day, 2), true);
});

test("the recheck may only read: a write, a send or another workspace is refused before the dispatcher", async () => {
  const calls = [];
  const call = recheckCallTool(async (name, args) => {
    calls.push([name, args]);
    return { content: [{ type: "text", text: "ok" }] };
  });
  for (const name of ["write_note", "send_email", "calendar_event", "remember", "move_note"]) {
    const result = await call(name, { path: "tex/about.md", content: "x" });
    assert.equal(result.isError, true, name);
  }
  assert.equal((await call("search_email", { query: "x", context: "@other" })).isError, true);
  assert.equal((await call("search_email", { query: "x" })).isError, undefined);
  assert.deepEqual(calls.map(([n]) => n), ["search_email"]);
  assert.ok(!RECHECK_READS.some((n) => /write|send|remember|move|archive|event/.test(n)));
});

test("the recheck question numbers each line and asks for drops and rewrites only", () => {
  const q = recheckQuestion([{ n: 4, line: "- Likes tea (2026-10-01)" }], { now: Date.UTC(2026, 10, 20, 12), timeZone: "America/New_York" });
  assert.match(q, /4: - Likes tea/);
  assert.match(q, /never add a line/);
});

test("the dream is told the budget only when its step names one", () => {
  const plain = dreamQuestion({ chat: "hi", first: false, since: 0, timeZone: "UTC" });
  assert.ok(!plain.includes("## Budget"));
  const budgeted = dreamQuestion({ chat: "hi", first: false, since: 0, timeZone: "UTC", budget: 12000 });
  assert.ok(budgeted.includes("under 12,000 characters"));
  assert.ok(budgeted.indexOf("## Budget") < budgeted.indexOf("## Tonight"));
  assert.match(budgetWords(), /until 2026-11-21/);
});

function fakeNotes(files) {
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      const body = files[args.path];
      if (body === undefined) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: e-${args.path}\npath: ${args.path}\n\n${body}` }] };
    }
    if (name === "write_note") {
      if (files[args.path] !== undefined && args.expected_etag !== `e-${args.path}`) return { isError: true, content: [{ type: "text", text: "conflict: changed" }] };
      writes.push(args.path);
      files[args.path] = args.content;
      return { content: [{ type: "text", text: "written" }] };
    }
    return { isError: true, content: [{ type: "text", text: "no" }] };
  };
  return { dispatch, writes, files };
}

test("expireAbout writes the note without past lines and logs each in the night's dream log", async () => {
  const notes = fakeNotes({ "tex/about.md": NOTE });
  const out = await expireAbout({ dispatch: notes.dispatch, timeZone: "America/New_York", now: Date.UTC(2026, 10, 22, 15) });
  assert.equal(out.outcome, "expired");
  assert.equal(out.dropped, 2);
  assert.deepEqual(out.when, ["check"]);
  assert.ok(!notes.files["tex/about.md"].includes("Party"));
  assert.match(notes.files["tex/dreams/2026-11-22.md"], /Past their day, taken out[\s\S]*Removed `- Party Sat/);
});

test("expireAbout on the evening of the until day (UTC already the next day) keeps the line", async () => {
  const notes = fakeNotes({ "tex/about.md": "# A\n\n- Party Sat Nov 21 (Tex noticed, 2026-11-19, until 2026-11-21)\n" });
  // 2026-11-22 02:00 UTC is still Nov 21 in New York.
  const out = await expireAbout({ dispatch: notes.dispatch, timeZone: "America/New_York", now: Date.UTC(2026, 10, 22, 2) });
  assert.equal(out.outcome, "nothing_due");
  assert.deepEqual(notes.writes, []);
});

test("expireAbout with no note writes nothing", async () => {
  const notes = fakeNotes({});
  const out = await expireAbout({ dispatch: notes.dispatch, timeZone: "UTC", now: Date.UTC(2026, 10, 22) });
  assert.equal(out.outcome, "no_note");
  assert.deepEqual(notes.writes, []);
});
