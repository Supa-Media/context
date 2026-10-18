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
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appOriginOf, noteLinkUrl, withNoteLinks } from "../src/agent/noteLinks.js";

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
  const read = { content: [{ type: "text", text: "written: a.md (etag x)" }] };
  const call = withNoteLinks(async () => read, { origin: ORIGIN, contexts: CONTEXTS });
  assert.equal(await call("read_note", { path: "a.md" }), read);
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
