/**
 * A texted write answers with the note's link (`agent/noteLinks.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-18).
 *
 *  1. `appOriginOf` accepting any scheme.
 *     → "no https origin, no link" fails.
 *  2. `withNoteLinks` adding the line to a failed write.
 *     → "a failed write gets no link" fails.
 *  3. `noteLinkUrl` without encoding segments.
 *     → "a name with spaces and a # is encoded, segment by segment" fails.
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-20).
 *
 *  4. `withNoteLinks` passing `read_note` through as before.
 *     → "a read in a shared workspace links to it there" fails.
 *  5. The read's link appended after the body instead of in the header.
 *     → "a read keeps its header and body, with the link after path:" fails.
 *  6. `NOTE_LINK_LINE` dropped from the texting prompt.
 *     → "a texted turn is told to send a note's link, production setup or not" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appOriginOf, NOTE_LINK_LINE, noteLinkUrl, withNoteLinks } from "../src/agent/noteLinks.js";
import { systemPrompt } from "../src/agent/prompt.js";

const ORIGIN = "https://app.example";
const CONTEXTS = [
  { name: "maya", current: true },
  { name: "hangg", current: false },
];
const written = (path) => ({ content: [{ type: "text", text: `written: ${path} (etag c2.abc)\nvisibility: private` }] });

test("a write in the turn's own context links to it there", async () => {
  const call = withNoteLinks(async () => written("1-projects/Supper club.md"), { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("write_note", { path: "1-projects/Supper club.md", content: "x" });
  assert.match(result.content[0].text, /\nlink: https:\/\/app\.example\/note\/@maya\/1-projects\/Supper%20club\.md /);
  assert.match(result.content[0].text, /^written: /);
});

test("a write that names another context links into that one", async () => {
  const call = withNoteLinks(async () => written("plan.md"), { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("write_note", { path: "plan.md", content: "x", context: "@hangg" });
  assert.match(result.content[0].text, /link: https:\/\/app\.example\/note\/@hangg\/plan\.md/);
});

test("a name with spaces and a # is encoded, segment by segment", () => {
  assert.equal(noteLinkUrl(ORIGIN, "maya", "a b/c#d?.md"), "https://app.example/note/@maya/a%20b/c%23d%3F.md");
});

test("a failed write gets no link", async () => {
  const refused = { isError: true, content: [{ type: "text", text: "written: nothing (etag x)" }] };
  const call = withNoteLinks(async () => refused, { origin: ORIGIN, contexts: CONTEXTS });
  assert.equal(await call("write_note", { path: "a.md" }), refused);
});

test("other tools pass through untouched", async () => {
  const found = { content: [{ type: "text", text: "written: a.md (etag x)\npath: a.md" }] };
  const call = withNoteLinks(async () => found, { origin: ORIGIN, contexts: CONTEXTS });
  assert.equal(await call("search_notes", { query: "a" }), found);
});

const read = (path) => ({
  content: [{ type: "text", text: `etag: c2.abc\npath: ${path}\nvisibility: team\n\n# Premiere to Resolve\n\npath: not a header` }],
});

test("a read in a shared workspace links to it there", async () => {
  const call = withNoteLinks(async () => read("SOPs/Premiere to Resolve.md"), { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("read_note", { path: "SOPs/Premiere to Resolve.md", context: "@v2l" });
  assert.match(result.content[0].text, /\nlink: https:\/\/app\.example\/note\/@v2l\/SOPs\/Premiere%20to%20Resolve\.md\n/);
});

test("a read keeps its header and body, with the link after path:", async () => {
  const call = withNoteLinks(async () => read("a.md"), { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("read_note", { path: "a.md" });
  assert.equal(
    result.content[0].text,
    "etag: c2.abc\npath: a.md\nlink: https://app.example/note/@maya/a.md\nvisibility: team\n\n# Premiere to Resolve\n\npath: not a header",
  );
});

test("a read links to where the note is now, not the path asked for", async () => {
  const moved = { content: [{ type: "text", text: "etag: e\npath: 2-areas/new.md\nvisibility: private\nmoved_from: old.md\n\nx" }] };
  const call = withNoteLinks(async () => moved, { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("read_note", { path: "old.md" });
  assert.match(result.content[0].text, /link: https:\/\/app\.example\/note\/@maya\/2-areas\/new\.md\n/);
});

test("a failed read, and a read of a note's mail, get no link", async () => {
  const refused = { isError: true, content: [{ type: "text", text: "etag: x\npath: a.md" }] };
  const call = withNoteLinks(async () => refused, { origin: ORIGIN, contexts: CONTEXTS });
  assert.equal(await call("read_note", { path: "a.md" }), refused);
  const mail = { content: [{ type: "text", text: "etag: x\npath: a.md\n\nmail" }] };
  const mailCall = withNoteLinks(async () => mail, { origin: ORIGIN, contexts: CONTEXTS });
  assert.equal(await mailCall("read_note", { path: "a.md", mail: "new" }), mail);
});

test("a texted turn is told to send a note's link, production setup or not", () => {
  for (const notes of [null, { prompt: "You are Tex." }]) {
    assert.ok(systemPrompt(null, { texting: true, notes }).includes(NOTE_LINK_LINE));
  }
  assert.match(NOTE_LINK_LINE, /Never say you don't have a link/);
  assert.match(NOTE_LINK_LINE, /share link only when they ask/);
});

test("no https origin, no link", () => {
  for (const env of [{}, { APP_ORIGIN: "" }, { APP_ORIGIN: "http://app.example" }, { APP_ORIGIN: "https://app.example/x" }, { APP_ORIGIN: 7 }]) {
    assert.equal(appOriginOf(env), null);
  }
  assert.equal(appOriginOf({ APP_ORIGIN: "https://app.example/" }), ORIGIN);
});

test("an unknown context name gives no link rather than a guessed one", async () => {
  const call = withNoteLinks(async () => written("a.md"), { origin: ORIGIN, contexts: [] });
  const result = await call("write_note", { path: "a.md" });
  assert.doesNotMatch(result.content[0].text, /link:/);
});
