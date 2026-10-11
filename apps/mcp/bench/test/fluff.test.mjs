// Tests for bench/fluff.mjs. Every note, name and date here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WORDS, expandFluff, mulberry32, parseFluff, resolveRel } from "../fluff.mjs";

const FLUFF = `---
count: 40
seed: 7
from: meetings
name: meeting-{date}.md
dates: 2026-01-05 to 2026-10-01
---
Free text for people, ignored by the expander.

## Distractors

- older copy of ../health/dentist.md as dentist-old.md dated 2026-03-02
`;

const BANK = {
  "a.md": "---\ntitle: Standup\n---\n\n# Standup {n}\n\nWe talked about {word} on {date}.\n",
  "b.md": "# Review\n\nNo front matter here, {word} and {word}.\n",
  "c.md": "---\nupdated: 2025-01-01\ntags: x\n---\n\nReview {n} with {word}.\n",
};

const DENTIST = "---\nupdated: 2026-01-01\n---\n\nDentist Tuesday 3 pm, Dr. Lee.\n";

/** Parse a fluff file from text, with only the lines a test changes. */
const fluffWith = (front, body = "") => parseFluff(`---\n${front}\n---\n${body}`);

const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`);

// ---- parseFluff ----

test("parseFluff reads the documented example", () => {
  assert.deepEqual(parseFluff(FLUFF), {
    count: 40,
    seed: 7,
    from: "meetings",
    name: "meeting-{date}.md",
    dates: { from: "2026-01-05", to: "2026-10-01" },
    updated: null,
    distractors: [{ from: "../health/dentist.md", as: "dentist-old.md", date: "2026-03-02" }],
  });
});

test("parseFluff needs only the required keys", () => {
  const f = fluffWith("count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md");
  assert.deepEqual(f.dates, null);
  assert.deepEqual(f.distractors, []);
  assert.equal(f.updated, null);
});

test("parseFluff reads the fluff file's own updated date", () => {
  const f = fluffWith("count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md\nupdated: 2026-02-14");
  assert.equal(f.updated, "2026-02-14");
});

test("parseFluff names the missing required key", () => {
  for (const key of ["count", "seed", "from", "name"]) {
    const lines = ["count: 3", "seed: 1", "from: meetings", "name: note-{n}.md"].filter((l) => !l.startsWith(`${key}:`));
    assert.throws(() => fluffWith(lines.join("\n")), new RegExp(`${key} is required`), `missing ${key}`);
  }
});

test("parseFluff accepts counts from 1 to 50,000 and refuses the rest", () => {
  const base = "seed: 1\nfrom: meetings\nname: note-{n}.md";
  assert.equal(fluffWith(`count: 1\n${base}`).count, 1);
  assert.equal(fluffWith(`count: 50000\n${base}`).count, 50000);
  assert.throws(() => fluffWith(`count: 50001\n${base}`), /50,000/);
  assert.throws(() => fluffWith(`count: 0\n${base}`), /count/);
  assert.throws(() => fluffWith(`count: forty\n${base}`), /count/);
  assert.throws(() => fluffWith(`count: 2.5\n${base}`), /count/);
});

test("parseFluff refuses a seed that is not a 32-bit whole number", () => {
  const base = "count: 3\nfrom: meetings\nname: note-{n}.md";
  assert.equal(fluffWith(`seed: 4294967295\n${base}`).seed, 4294967295);
  assert.throws(() => fluffWith(`seed: -1\n${base}`), /seed/);
  assert.throws(() => fluffWith(`seed: seven\n${base}`), /seed/);
});

test("parseFluff refuses a from that is a path rather than a folder name", () => {
  const base = "count: 3\nseed: 1\nname: note-{n}.md";
  assert.throws(() => fluffWith(`from: ../tests\n${base}`), /from/);
  assert.throws(() => fluffWith(`from: a/b\n${base}`), /from/);
  assert.throws(() => fluffWith(`from: ..\n${base}`), /from/);
});

test("parseFluff requires a name with {n} or {date}, only those placeholders, ending in .md", () => {
  const base = "count: 3\nseed: 1\nfrom: meetings";
  assert.throws(() => fluffWith(`${base}\nname: note.md`), /\{n\}|\{date\}/);
  assert.throws(() => fluffWith(`${base}\nname: note-{word}.md`), /\{word\}/);
  assert.throws(() => fluffWith(`${base}\nname: note-{n}.txt`), /\.md/);
  assert.throws(() => fluffWith(`${base}\nname: sub/note-{n}.md`), /name/);
  assert.equal(fluffWith(`${base}\nname: {date}.md`).name, "{date}.md");
});

test("parseFluff refuses dates that are reversed, not ISO, or not real days", () => {
  const base = "count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md";
  assert.throws(() => fluffWith(`${base}\ndates: 2026-10-01 to 2026-01-05`), /dates/);
  assert.throws(() => fluffWith(`${base}\ndates: 2026-02-30 to 2026-03-01`), /2026-02-30/);
  assert.throws(() => fluffWith(`${base}\ndates: 01/05/2026 to 10/01/2026`), /dates/);
  assert.throws(() => fluffWith(`${base}\nupdated: 2026-13-01`), /updated/);
});

test("parseFluff refuses a key it does not know, so a typo cannot pass silently", () => {
  assert.throws(() => fluffWith("cuont: 3\ncount: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md"), /cuont/);
});

test("parseFluff refuses a file with no front matter", () => {
  assert.throws(() => parseFluff("count: 3\n"), /front matter/);
  assert.throws(() => parseFluff("---\ncount: 3\nseed: 1\n"), /---/);
});

test("parseFluff names the line of a distractor it cannot read", () => {
  const raw = FLUFF.replace("- older copy of ../health/dentist.md as dentist-old.md dated 2026-03-02", "- older copy of ../health/dentist.md dated 2026-03-02");
  assert.throws(() => parseFluff(raw), (err) => {
    assert.match(err.message, /line 12/);
    assert.match(err.message, /older copy of <path> as <name> dated <date>/);
    return true;
  });
});

test("parseFluff refuses a distractor whose copy would be a fluff file or not a note", () => {
  const body = "\n## Distractors\n\n- older copy of ../x.md as fluff.md dated 2026-03-02\n";
  assert.throws(() => fluffWith("count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md", body), /fluff\.md is the fluff file itself/);
  const slash = "\n## Distractors\n\n- older copy of ../x.md as sub/x.md dated 2026-03-02\n";
  assert.throws(() => fluffWith("count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md", slash), /bare \.md file name/);
});

test("parseFluff ignores bullets outside the Distractors section", () => {
  const body = "\n## Notes\n\n- older copy of ../x.md as y.md dated 2026-03-02 (just a remark)\n";
  assert.deepEqual(fluffWith("count: 3\nseed: 1\nfrom: meetings\nname: note-{n}.md", body).distractors, []);
});

test("parseFluff accepts CRLF line endings", () => {
  assert.deepEqual(parseFluff(FLUFF.replace(/\n/g, "\r\n")), parseFluff(FLUFF));
});

// ---- mulberry32 and the word list ----

test("mulberry32 gives the same sequence for the same seed, in [0, 1)", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("the word list has 100 distinct plain words", () => {
  assert.equal(WORDS.length, 100);
  assert.equal(new Set(WORDS).size, 100);
  assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)));
});

// ---- resolveRel ----

test("resolveRel resolves a path against the fluff file's folder", () => {
  assert.equal(resolveRel("meetings", "../health/dentist.md"), "health/dentist.md");
  assert.equal(resolveRel("", "notes/x.md"), "notes/x.md");
});

test("resolveRel refuses a path that leaves the workspace or is absolute", () => {
  assert.throws(() => resolveRel("meetings", "../../secrets.md"), /outside the workspace/);
  assert.throws(() => resolveRel("", "../x.md"), /outside the workspace/);
  assert.throws(() => resolveRel("meetings", "/etc/x.md"), /relative/);
});

// ---- expandFluff ----

test("the same seed gives byte-identical notes", () => {
  const fluff = parseFluff(FLUFF);
  const files = { "health/dentist.md": DENTIST };
  const one = expandFluff({ dir: "meetings", fluff, templates: BANK, files });
  const two = expandFluff({ dir: "meetings", fluff, templates: BANK, files });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(Object.keys(one).length, 41);
});

test("a different seed gives different notes", () => {
  const one = expandFluff({ dir: "m", fluff: fluffWith("count: 20\nseed: 7\nfrom: x\nname: n-{n}.md\ndates: 2026-01-01 to 2026-12-31"), templates: BANK });
  const two = expandFluff({ dir: "m", fluff: fluffWith("count: 20\nseed: 8\nfrom: x\nname: n-{n}.md\ndates: 2026-01-01 to 2026-12-31"), templates: BANK });
  assert.notEqual(JSON.stringify(one), JSON.stringify(two));
});

test("notes are named by index, zero-padded to the width of count, under the fluff file's folder", () => {
  const out = expandFluff({ dir: "people", fluff: fluffWith("count: 12\nseed: 1\nfrom: x\nname: note-{n}.md"), templates: BANK });
  assert.deepEqual(Object.keys(out), Array.from({ length: 12 }, (_, i) => `people/note-${String(i + 1).padStart(2, "0")}.md`));
});

test("{date} names are drawn from the range and read in ascending order", () => {
  const fluff = fluffWith("count: 50\nseed: 3\nfrom: x\nname: meeting-{date}.md\ndates: 2026-01-05 to 2026-10-01");
  const out = expandFluff({ dir: "m", fluff, templates: BANK });
  const dates = Object.values(out).map((text) => text.match(/^updated: (\S+)$/m)[1]);
  assert.deepEqual([...dates].sort(), dates, "dates ascend with the note index");
  for (const d of dates) {
    assert.ok(dayOf(d) >= dayOf("2026-01-05") && dayOf(d) <= dayOf("2026-10-01"), d);
  }
  for (const path of Object.keys(out)) assert.match(path, /^m\/meeting-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/);
});

test("each note's front matter carries its own updated date, once, at the top", () => {
  const out = expandFluff({ dir: "m", fluff: fluffWith("count: 9\nseed: 2\nfrom: x\nname: n-{n}.md\ndates: 2026-02-01 to 2026-02-28"), templates: BANK });
  for (const [path, text] of Object.entries(out)) {
    assert.match(text, /^---\nupdated: 2026-02-\d{2}\n/, path);
    assert.equal(text.match(/^updated:/gm).length, 1, path);
  }
});

test("a template's own front matter is merged, with its old updated line replaced", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 1\nseed: 1\nfrom: x\nname: n-{n}.md\ndates: 2026-05-05 to 2026-05-05"),
    templates: { "c.md": BANK["c.md"] },
  });
  assert.match(out["m/n-1.md"], /^---\nupdated: 2026-05-05\ntags: x\n---\n\nReview 1 with [a-z]+\.\n$/);
});

test("a template without front matter gets a front matter block", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 1\nseed: 1\nfrom: x\nname: n-{n}.md\ndates: 2026-05-05 to 2026-05-05"),
    templates: { "b.md": BANK["b.md"] },
  });
  assert.match(out["m/n-1.md"], /^---\nupdated: 2026-05-05\n---\n# Review\n\nNo front matter here, \S+ and \S+\.\n$/);
});

test("{n}, {date} and {word} in a template are all replaced", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 30\nseed: 4\nfrom: x\nname: n-{n}.md\ndates: 2026-01-01 to 2026-12-31"),
    templates: BANK,
  });
  for (const [path, text] of Object.entries(out)) {
    assert.doesNotMatch(text, /\{(n|date|word)\}/, path);
  }
});

test("each {word} is a fresh draw from the word list", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 20\nseed: 5\nfrom: x\nname: n-{n}.md"),
    templates: { "w.md": "{word} {word}\n" },
  });
  const pairs = Object.values(out).map((text) => text.match(/^---\n[\s\S]*?\n---\n([a-z]+) ([a-z]+)\n$/));
  for (const m of pairs) {
    assert.ok(m, "a word pair");
    assert.ok(WORDS.includes(m[1]) && WORDS.includes(m[2]));
  }
  assert.ok(pairs.some((m) => m[1] !== m[2]), "two draws differ somewhere");
});

test("a template's text outside the three placeholders is left alone", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 1\nseed: 1\nfrom: x\nname: n-{n}.md\ndates: 2026-05-05 to 2026-05-05"),
    templates: { "d.md": "Use {curly} braces and $1 literally, {n}.\n" },
  });
  assert.match(out["m/n-1.md"], /\{curly\} braces and \$1 literally, 1\./);
});

test("with no dates, every note is dated the fluff file's updated, or 2026-01-01", () => {
  const plain = expandFluff({ dir: "m", fluff: fluffWith("count: 2\nseed: 1\nfrom: x\nname: n-{n}.md"), templates: BANK });
  for (const text of Object.values(plain)) assert.match(text, /^---\nupdated: 2026-01-01\n/m);
  const dated = expandFluff({ dir: "m", fluff: fluffWith("count: 2\nseed: 1\nfrom: x\nname: n-{n}.md\nupdated: 2026-02-14"), templates: BANK });
  for (const text of Object.values(dated)) assert.match(text, /^---\nupdated: 2026-02-14\n/m);
});

test("two notes with the same name get -{n} appended, deterministically", () => {
  const out = expandFluff({
    dir: "meetings",
    fluff: fluffWith("count: 3\nseed: 1\nfrom: x\nname: meeting-{date}.md\ndates: 2026-01-05 to 2026-01-05"),
    templates: BANK,
  });
  assert.deepEqual(Object.keys(out), ["meetings/meeting-2026-01-05.md", "meetings/meeting-2026-01-05-2.md", "meetings/meeting-2026-01-05-3.md"]);
});

test("a distractor copies an existing note under its new name, dated and marked", () => {
  const out = expandFluff({
    dir: "meetings",
    fluff: parseFluff(FLUFF),
    templates: BANK,
    files: { "health/dentist.md": DENTIST },
  });
  assert.equal(out["meetings/dentist-old.md"], "---\nupdated: 2026-03-02\n---\n\n(older copy) Dentist Tuesday 3 pm, Dr. Lee.\n");
  assert.ok(!("health/dentist.md" in out), "the source is copied, not written again");
});

test("a distractor marks the first line of text in a body that has no front matter", () => {
  const out = expandFluff({
    dir: "m",
    fluff: fluffWith("count: 1\nseed: 1\nfrom: x\nname: n-{n}.md", "\n## Distractors\n\n- older copy of plain.md as old.md dated 2026-03-02\n"),
    templates: BANK,
    files: { "m/plain.md": "\nFirst line.\nSecond.\n" },
  });
  assert.equal(out["m/old.md"], "---\nupdated: 2026-03-02\n---\n\n(older copy) First line.\nSecond.\n");
});

test("a distractor naming a missing note is an error that names it", () => {
  assert.throws(
    () => expandFluff({ dir: "meetings", fluff: parseFluff(FLUFF), templates: BANK, files: {} }),
    /copies health\/dentist\.md, which is not a note in this workspace/,
  );
});

test("a distractor cannot reach outside the workspace", () => {
  const fluff = fluffWith("count: 1\nseed: 1\nfrom: x\nname: n-{n}.md", "\n## Distractors\n\n- older copy of ../../../etc/x.md as x.md dated 2026-03-02\n");
  assert.throws(() => expandFluff({ dir: "meetings", fluff, templates: BANK, files: {} }), /outside the workspace/);
});

test("a generated note never overwrites a hand-written note", () => {
  const fluff = fluffWith("count: 3\nseed: 1\nfrom: x\nname: meeting-{date}.md\ndates: 2026-01-05 to 2026-01-05");
  assert.throws(
    () => expandFluff({ dir: "meetings", fluff, templates: BANK, files: { "meetings/meeting-2026-01-05.md": "mine\n" } }),
    /meetings\/meeting-2026-01-05\.md would overwrite a hand-written note/,
  );
});

test("a distractor copy never overwrites a hand-written note either", () => {
  const files = { "health/dentist.md": DENTIST, "meetings/dentist-old.md": "mine\n" };
  assert.throws(
    () => expandFluff({ dir: "meetings", fluff: parseFluff(FLUFF), templates: BANK, files }),
    /meetings\/dentist-old\.md would overwrite a hand-written note/,
  );
});

test("a fluff file naming an empty or missing template folder is refused", () => {
  assert.throws(() => expandFluff({ dir: "m", fluff: fluffWith("count: 1\nseed: 1\nfrom: nope\nname: n-{n}.md"), templates: undefined }), /nope/);
  assert.throws(() => expandFluff({ dir: "m", fluff: fluffWith("count: 1\nseed: 1\nfrom: nope\nname: n-{n}.md"), templates: {} }), /nope/);
});

test("expanding 20,000 notes from a 3-template bank takes under 5 seconds", () => {
  const fluff = parseFluff("---\ncount: 20000\nseed: 9\nfrom: bank\nname: note-{n}.md\ndates: 2020-01-01 to 2026-12-31\n---\n");
  const started = performance.now();
  const out = expandFluff({ dir: "big", fluff, templates: BANK });
  const elapsed = performance.now() - started;
  assert.equal(Object.keys(out).length, 20000);
  assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
});
