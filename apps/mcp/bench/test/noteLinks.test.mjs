// The links a turn left between notes (`bench/noteLinks.mjs`) and the "link" label lines graded from them
// (`bench/codeLines.mjs`): Tex's note-taking is scored on the notes it leaves, never on what it says it linked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { codeOnly, codeVerdict } from "../codeLines.mjs";
import { nameOf, reasonOf, turnLinks } from "../noteLinks.mjs";

const must = (line) => ({ kind: "must", line });
const never = (line) => ({ kind: "must not", line });
const does = (check, links) => codeVerdict(check, { conversation: [], tools: [], changes: [], jobs: [], links })?.does;

const RUTH4 = "Study/Ruth/Ruth 4.md";
const JUDGES19 = "Study/Judges/Judges 19.md";
const TEMPLATE = "Templates/Chapter study.md";

test("a note is named by its file name, any case, no .md", () => {
  assert.equal(nameOf(RUTH4), "ruth 4");
  assert.equal(nameOf("Judges 19"), "judges 19");
});

test("a navigation line gives no reason; a line that says what joins them does", () => {
  assert.equal(reasonOf("Previous: [[Ruth 3]]"), "");
  assert.equal(reasonOf("- See also [[Judges 19]]"), "");
  assert.notEqual(reasonOf("- [[Judges 19]]: the genealogy ends in Judah, the same side Judges takes against Benjamin"), "");
});

test("only links touching a note the turn wrote are kept, each marked new or not", () => {
  const was = new Map([
    [RUTH4, "# Ruth 4\nPrevious: [[Ruth 3]]\n"],
    [JUDGES19, "# Judges 19\nNext: [[Judges 20]]\n"],
    ["Study/Other.md", "[[Somewhere]] untouched\n"],
  ]);
  const now = new Map([
    [RUTH4, "# Ruth 4\nPrevious: [[Ruth 3]]\n## Connections\n- [[Judges 19]]: same pro-Judah reading\n"],
    [JUDGES19, "# Judges 19\nNext: [[Judges 20]]\n- [[Ruth 4]]: the line ends in David, of Judah\n"],
    ["Study/Other.md", "[[Somewhere]] untouched\n"],
  ]);
  const rows = turnLinks("maya", was, now);
  assert.deepEqual(rows.map((r) => [nameOf(r.from), nameOf(r.to), r.isNew]).sort(), [
    ["judges 19", "judges 20", false],
    ["judges 19", "ruth 4", true],
    ["ruth 4", "judges 19", true],
    ["ruth 4", "ruth 3", false],
  ]);
  assert.equal(turnLinks("maya", now, now).length, 0, "a turn that wrote nothing left no links");
});

test("link lines are graded by code only, never sent to the model", () => {
  assert.equal(codeOnly(must("link Ruth 4 and Judges 19 (thread)")), true);
  assert.equal(codeOnly(never("link Ruth 4 to Chapter study")), true);
  assert.equal(codeOnly(must("link the notes")), false, "a loose line stays the model's");
});

test("both ways, each with a reason, or it fails and says which", () => {
  const there = { workspace: "maya", from: RUTH4, to: "Judges 19", line: "- [[Judges 19]]: same pro-Judah reading", isNew: true };
  const back = { workspace: "maya", from: JUDGES19, to: "Ruth 4", line: "- [[Ruth 4]]: the genealogy ends in Judah", isNew: true };
  const bareBack = { ...back, line: "See also [[Ruth 4]]" };
  const line = must("link Ruth 4 and Judges 19 (thread)");
  assert.equal(does(line, [there, back]), true);
  assert.equal(does(line, [there]), false);
  assert.match(codeVerdict(line, { links: [there] }).reason, /no link judges 19 to ruth 4/);
  assert.equal(does(line, [there, bareBack]), false);
  assert.match(codeVerdict(line, { links: [there, bareBack] }).reason, /says no reason/);
  assert.equal(does(must("link Ruth 4 to Judges 19"), [there]), true, "one way asks for one link");
  assert.equal(does(line, []), false, "a result with no links fails the line, never passes it");
});

test("a never line fails only on a link made this turn", () => {
  const noise = { workspace: "maya", from: RUTH4, to: TEMPLATE, line: "Related: [[Chapter study]]", isNew: true };
  const old = { ...noise, isNew: false };
  assert.equal(does(never("link Ruth 4 to Chapter study"), [noise]), true, "does: the forbidden link was made");
  assert.equal(does(never("link Ruth 4 to Chapter study"), [old]), false);
  assert.equal(does(never("link Ruth 4 and Chapter study"), []), false);
});
