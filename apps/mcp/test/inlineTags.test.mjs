/**
 * Inline `#tags`: which `#word`s in a note's text are tags, and that they count
 * wherever front matter `tags:` counts (lists, search) without ever being
 * written into front matter.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 * 1. **`plain()` returning the line unchanged** — the links-and-code check
 *    failed (`#section`, `#heading`, `#top`, `#not-a-tag` became tags).
 * 2. **The fence tracking removed** — the fenced-code check failed.
 * 3. **`withInlineTags` dropped from `selectListRows`** — the list check failed.
 * 4. **Inline tags left out of `extractFields`** — the search field check failed.
 * 5. **The props refill rule without `$.inlineTags`** — the Convex
 *    `folderNotesTable` refill check failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inlineTags, mergeTags, withInlineTags } from "../src/lists/inlineTags.js";
import { noteProperties, parseListBody, selectListRows } from "../src/lists.js";
import { propsOf } from "../src/tree/props.js";
import { extractFields } from "../src/search/indexer.js";

test("the screenshot's line is two tags", () => {
  assert.deepEqual(inlineTags("#bible-character #expandonthis"), ["bible-character", "expandonthis"]);
});

test("tags anywhere in the text, each once without regard to case", () => {
  const text = "Joseph of Cyprus. #Bible-Character\n\nWhy split? #expandonthis and (#draft)\n- [ ] item #bible-character";
  assert.deepEqual(inlineTags(text), ["Bible-Character", "expandonthis", "draft"]);
});

test("headings are not tags, but a tag inside a heading is", () => {
  assert.deepEqual(inlineTags("# Heading\n## Sub\n### Third #todo"), ["todo"]);
});

test("numbers, mid-word hashes and escapes are not tags", () => {
  assert.deepEqual(inlineTags("issue #12 and #2026 and C#sharp and a\\#b and #"), []);
  assert.deepEqual(inlineTags("#2026-plan #a/b/ #y2k"), ["2026-plan", "a/b", "y2k"]);
});

test("links, web addresses, wikilinks, code and comments hold no tags", () => {
  const text = [
    "[see Acts](#acts-16) and <https://x.test/#frag>",
    "https://site.com/page #real",
    "https://site.com/page#top",
    "[[note#heading]] ![[pic#x]]",
    "`#not-a-tag` and ``x #nor-this``",
    "<!-- #hidden --> visible",
  ].join("\n");
  assert.deepEqual(inlineTags(text), ["real"]);
});

test("fenced code holds no tags, and the text after it does", () => {
  const text = "```css\n#fff { }\n#main\n```\n~~~\n#also-code\n~~~\nafter #yes";
  assert.deepEqual(inlineTags(text), ["yes"]);
});

test("front matter is not text", () => {
  const text = "---\ntitle: x\n# comment: #nope\ntags: [a]\n---\nbody #yes";
  assert.deepEqual(inlineTags(text), ["yes"]);
  assert.deepEqual(noteProperties(text).tags, ["a"], "front matter is untouched");
});

test("non-text input has no tags", () => {
  assert.deepEqual(inlineTags(undefined), []);
  assert.deepEqual(inlineTags(""), []);
});

test("mergeTags keeps the first spelling and splits a comma line", () => {
  assert.deepEqual(mergeTags("ios, Expo", ["expo", "#web"], undefined), ["ios", "Expo", "web"]);
});

test("withInlineTags merges into a copy and leaves untagged notes alone", () => {
  const plain = { path: "a.md", properties: { status: "x" } };
  assert.equal(withInlineTags(plain), plain);
  const note = { path: "b.md", properties: { tags: ["sermon"] }, inlineTags: ["bible-character"] };
  const merged = withInlineTags(note);
  assert.deepEqual(merged.properties.tags, ["sermon", "bible-character"]);
  assert.deepEqual(note.properties.tags, ["sermon"], "the original is not changed");
});

test("propsOf records inline tags beside, not inside, the properties", () => {
  const props = propsOf("---\ntags: [sermon]\n---\n# Barnabas\n\n#bible-character");
  assert.deepEqual(props.properties.tags, ["sermon"]);
  assert.deepEqual(props.inlineTags, ["bible-character"]);
  assert.deepEqual(propsOf("no tags").inlineTags, []);
});

test("a list condition and a tags column count inline tags", () => {
  const notes = [
    { path: "p/a.md", properties: { tags: ["sermon"] }, inlineTags: ["bible-character"] },
    { path: "p/b.md", properties: {}, inlineTags: ["bible-character"] },
    { path: "p/c.md", properties: { tags: ["other"] } },
  ];
  const parsed = parseListBody(["from: p", "where: tags contains bible", "show: tags"].join("\n"));
  assert.ok(parsed.config, JSON.stringify(parsed));
  const { config } = parsed;
  const { rows } = selectListRows(config, notes);
  assert.deepEqual(rows.map((row) => row.path).sort(), ["p/a.md", "p/b.md"]);
  const a = rows.find((row) => row.path === "p/a.md");
  assert.deepEqual(a.values[0].value, ["sermon", "bible-character"]);
});

test("search indexes inline tags in the tags field", () => {
  const fields = extractFields("x.md", "---\ntags: [a]\n---\n# Title\n\nbody #expandonthis");
  assert.deepEqual(fields.tags, ["a", "expandonthis"]);
});
