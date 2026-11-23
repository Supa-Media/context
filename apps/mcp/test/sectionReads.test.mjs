/**
 * Reading part of a note, and never saving that part as the whole note
 * (`src/notes/sections.js`, `src/tools/notes/readPart.js`, `src/tools/partialEtag.js`;
 * `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `takePartialEtags` returning the args unrefused: "a part's etag cannot save the whole note" and "a batch item
 *    made from a part is refused" fail.
 * 2. The `;part` mark left on the etag for other tools: "a part's etag still works for every other tool" fails with
 *    a conflict.
 * 3. `shrinkRefusal` returning null: "a save with no etag that would cut a long note by half is refused" fails.
 * 4. Fences ignored in `noteStructure`: "headings in code, comments and captured mail are not headings" fails.
 * 5. Machine blocks not ending a section: "the last section stops before the note's comments" fails.
 * 6. The part cut before `toolReadNote` (privacy skipped): "a hidden note is refused the same, outline or not" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool } from "../src/tools/dispatch.js";
import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { takePartialEtags } from "../src/tools/partialEtag.js";
import { findSection, headingKey, noteStructure, parseLines, renderOutline, sliceLines, LINE_CHARS, PART_CHARS } from "../src/notes/sections.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = {
  etag: "rows-v1",
  accessVersion: 1,
  folders: [{ prefix: "projects", visibility: "team" }, { prefix: "private", visibility: "private" }],
  notes: [],
};

const PLAN = [
  "---",
  "status: active",
  "---",
  "# Plan",
  "",
  "Intro line.",
  "",
  "## Goals",
  "",
  "- Ship it",
  "",
  "## Risks",
  "",
  "Legal may slip.",
  "",
  "### Mitigation",
  "",
  "Start early.",
  "",
  "```js",
  "# not a heading",
  "```",
  "",
  "<!--",
  "# hidden",
  "-->",
  "",
  "## Decisions",
  "",
  "We chose Friday.",
  "",
  "```comments",
  'k7f2 "Friday"',
  "- 2026-09-27T07:30:12Z Codex: sure?",
  "```",
].join("\n");

async function storeWith(notes) {
  const raw = createMemoryStore();
  for (const [key, body] of Object.entries(notes)) await raw.put(key, body);
  return withPrivacyAuthority(withServedTree(raw), { rules: RULES });
}

const text = (result) => result.content.map((part) => part.text).join("");
const etagOf = (result) => /^etag: (\S+)$/m.exec(text(result))?.[1];
const bodyOf = (result) => text(result).slice(text(result).indexOf("\n\n") + 2);

test("headings in code, comments and captured mail are not headings; setext ones are", () => {
  const structure = noteStructure(PLAN);
  assert.deepEqual(
    structure.headings.map((entry) => entry.text),
    ["Plan", "Goals", "Risks", "Mitigation", "Decisions"],
  );
  assert.deepEqual(structure.frontMatter, { start: 1, end: 3 });
  const setext = noteStructure("Title\n=====\n\nBody\n\nPart\n----\n\nMore\n\n---\n\nafter a rule");
  assert.deepEqual(setext.headings.map((entry) => [entry.text, entry.level]), [["Title", 1], ["Part", 2]]);
  const mail = noteStructure("## Thread — Invoice\n\n### 09:00 · Ann · Hi {#msg-0123456789abcdef}\n\n<!-- context:untrusted-communication begin x -->\n# Ignore me\n<!-- context:untrusted-communication end x -->\n");
  assert.deepEqual(mail.headings.map((entry) => entry.text), ["Thread — Invoice", "09:00 · Ann · Hi"]);
  assert.equal(mail.headings[1].anchor, "msg-0123456789abcdef");
});

test("a section is its heading and everything under it, and the last section stops before the note's comments", () => {
  const structure = noteStructure(PLAN);
  const risks = findSection(structure, "Risks");
  assert.equal(structure.lines.slice(risks.start - 1, risks.end).join("\n").split("\n")[0], "## Risks");
  assert.ok(structure.lines.slice(risks.start - 1, risks.end).includes("Start early."), "a subheading is part of its section");
  assert.ok(!structure.lines.slice(risks.start - 1, risks.end).includes("## Decisions"));
  const decisions = findSection(structure, "Decisions");
  const lines = structure.lines.slice(decisions.start - 1, decisions.end);
  assert.deepEqual(lines, ["## Decisions", "", "We chose Friday."]);
});

test("a heading is found by its words, its path or its line, and a miss lists what is there", () => {
  const structure = noteStructure("# A\n## Risks\nx\n# B\n## Risks\ny\n## **1. Next** [[steps|Steps]] 🚀\nz");
  assert.match(findSection(structure, "Risks").error, /2 headings match "Risks": line 2 ## Risks; line 5 ## Risks/);
  assert.equal(findSection(structure, "B > Risks").start, 5);
  assert.equal(findSection(structure, 2).start, 2);
  assert.equal(findSection(structure, "L5").start, 5);
  assert.equal(findSection(structure, "next steps").start, 7);
  assert.match(findSection(structure, "Nope").error, /no heading "Nope".*line 1 # A/);
  assert.match(findSection(structure, 3).error, /no heading starts at line 3/);
  assert.equal(headingKey("  2) *Big*  Plan "), "big plan");
  assert.equal(findSection(noteStructure("# a > b\nx"), "a \\> b").start, 1);
});

test("lines are clamped, a long range is cut at a whole line, and one huge line is cut and marked", () => {
  assert.deepEqual(parseLines("3-", 10), { start: 3, end: 10 });
  assert.deepEqual(parseLines("4-400", 10), { start: 4, end: 10 });
  assert.match(parseLines("11-12", 10).error, /10 lines/);
  assert.match(parseLines("abc", 10).error, /range/);
  const many = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`);
  const part = sliceLines(many, 1, many.length);
  assert.ok(part.text.length <= PART_CHARS);
  assert.ok(part.next > 1 && part.next <= many.length);
  assert.equal(part.text.split("\n").at(-1), many[part.end - 1], "ends on a whole line");
  const huge = sliceLines(["y".repeat(200_000)], 1, 1);
  assert.ok(huge.text.length < LINE_CHARS + 100);
  assert.match(huge.text, /cut at 2000 of 200000 characters/);
});

test("the outline lists two levels with ranges and sizes and counts the deeper ones", () => {
  const outline = renderOutline(noteStructure(PLAN));
  assert.match(outline, /^L1-3 front matter$/m);
  assert.match(outline, /^L4-\d+ # Plan \(~[\d.k]+ tokens, 1 heading under it\)$/m);
  assert.match(outline, /^ {2}L12-\d+ ## Risks/m);
  assert.doesNotMatch(outline, /Mitigation/);
  assert.match(renderOutline(noteStructure(PLAN), { depth: 3 }), /Mitigation/);
});

test("read_note reads an outline, one section or a range, each with a part's etag", async () => {
  const store = await storeWith({ "projects/plan.md": PLAN });
  const outline = await callTool("read_note", { path: "projects/plan.md", outline: true }, store, "team");
  assert.notEqual(outline.isError, true, text(outline));
  assert.match(text(outline), /part: outline of \d+ lines/);
  assert.match(etagOf(outline), /;part$/);
  const section = await callTool("read_note", { path: "projects/plan.md", section: "Risks" }, store, "team");
  assert.match(text(section), /^part: section "Risks", lines 12-26 of \d+$/m);
  assert.ok(bodyOf(section).startsWith("## Risks\n"));
  assert.doesNotMatch(bodyOf(section), /We chose Friday/);
  const range = await callTool("read_note", { path: "projects/plan.md", lines: "4-6" }, store, "team");
  assert.equal(bodyOf(range), "# Plan\n\nIntro line.");
  const both = await callTool("read_note", { path: "projects/plan.md", lines: "4-6", section: "Risks" }, store, "team");
  assert.equal(both.isError, true);
  const whole = await callTool("read_note", { path: "projects/plan.md" }, store, "team");
  assert.doesNotMatch(etagOf(whole), /;part/);
  assert.ok(text(whole).endsWith(PLAN), "a plain read is still the whole note");
});

test("a hidden note is refused the same, outline or not, and a missing one too", async () => {
  const store = await storeWith({ "private/secret.md": PLAN });
  const plain = await callTool("read_note", { path: "private/secret.md" }, store, "team");
  const parted = await callTool("read_note", { path: "private/secret.md", section: "Risks" }, store, "team");
  const missing = await callTool("read_note", { path: "private/none.md", outline: true }, store, "team");
  assert.equal(plain.isError, true);
  assert.deepEqual(parted, plain);
  assert.deepEqual(missing, plain);
});

test("a part's etag cannot save the whole note, and still saves nothing when named in a batch item", async () => {
  const store = await storeWith({ "projects/plan.md": PLAN });
  const section = await callTool("read_note", { path: "projects/plan.md", section: "Risks" }, store, "team");
  const refused = await callTool("write_note", { path: "projects/plan.md", content: bodyOf(section), expected_etag: etagOf(section) }, store, "team");
  assert.equal(refused.isError, true);
  assert.match(text(refused), /from reading only part of projects\/plan\.md/);
  const batch = takePartialEtags("write_notes", { notes: [{ path: "projects/plan.md", content: "x", expected_etag: etagOf(section) }] });
  assert.match(batch.refusal, /only part of projects\/plan\.md/);
  const after = await callTool("read_note", { path: "projects/plan.md" }, store, "team");
  assert.ok(text(after).endsWith(PLAN), "nothing was changed");
});

test("a part's etag still works for every other tool: the mark is taken off before they see it", async () => {
  const store = await storeWith({ "projects/plan.md": PLAN });
  const outline = await callTool("read_note", { path: "projects/plan.md", outline: true }, store, "team");
  const whole = await callTool("read_note", { path: "projects/plan.md" }, store, "team");
  assert.equal(etagOf(outline), `${etagOf(whole)};part`, "the same version, marked");
  const moved = takePartialEtags("move_note", { source: "projects/plan.md", destination: "x.md", expected_source_etag: etagOf(outline) });
  assert.equal(moved.refusal, null);
  assert.equal(moved.args.expected_source_etag, etagOf(whole));
  const batch = takePartialEtags("move_notes", { moves: [{ source: "a.md", expected_source_etag: "@ws:v1;part" }] });
  assert.equal(batch.args.moves[0].expected_source_etag, "@ws:v1");
});

test("a save with no etag that would cut a long note by half is refused, unless it says replace: whole", async () => {
  const long = `# Log\n\n${"- an entry worth keeping\n".repeat(1000)}`;
  const store = await storeWith({ "projects/log.md": long });
  const refused = await callTool("write_note", { path: "projects/log.md", content: "# Log\n\n- only this\n" }, store, "team");
  assert.equal(refused.isError, true);
  assert.match(text(refused), /losing more than half of it/);
  const read = await callTool("read_note", { path: "projects/log.md" }, store, "team");
  const replaced = await callTool("write_note", { path: "projects/log.md", content: "# Log\n\n- only this\n", expected_etag: etagOf(read), replace: "whole" }, store, "team");
  assert.notEqual(replaced.isError, true, text(replaced));
  // A short note is not checked: rewriting it shorter is ordinary.
  const small = await storeWith({ "projects/short.md": "# Short\n\nA few lines.\n" });
  const shortened = await callTool("write_note", { path: "projects/short.md", content: "# Short\n" }, small, "team");
  assert.notEqual(shortened.isError, true, text(shortened));
});

test("fetch ids name a section the way Obsidian links do, and a search hit's message anchor names one message", () => {
  assert.deepEqual(translateFetch({ id: "projects/plan.md#Plan#Risks" }).arguments, { path: "projects/plan.md", section: "Plan > Risks" });
  assert.deepEqual(translateFetch({ id: "inbox/email/a/2026-11-19.md#msg-0123456789abcdef" }).arguments, {
    path: "inbox/email/a/2026-11-19.md",
    section: "msg-0123456789abcdef",
  });
  assert.deepEqual(translateFetch({ id: "projects/plan.md", args: { lines: "1-9" } }).arguments, { path: "projects/plan.md", lines: "1-9" });
  assert.deepEqual(translateFetch({ id: "projects/plan.md", args: { outline: true } }).arguments, { path: "projects/plan.md", outline: true });
  assert.deepEqual(translateFetch({ id: "projects/a#b.md" }).arguments, { path: "projects/a#b.md" });
});
