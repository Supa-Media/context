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
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-10).
 *
 *  7. `noteLinkUrl` sending a page to `/note/` as before.
 *     → "a page's link opens the page viewer, a plain note's the app" fails.
 *  8. `sentNoteLinks` reading only `/note/` links.
 *     → "a page link they text is read as the note" fails.
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-17).
 *
 *  9. `slugFor` reading only `args.context`, as before.
 *     → "a read that names its workspace only in the path links into that workspace" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appOriginOf, NOTE_LINK_LINE, noteLinkUrl, sentNoteLinks, withNoteLinks, withSavedLink } from "../src/agent/noteLinks.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { withActivityHint } from "../src/live/activityHint.js";

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

test("a page's link opens the page viewer, a plain note's the app", () => {
  assert.equal(noteLinkUrl(ORIGIN, "maya", "trips/june trip.page.md"), "https://app.example/p/@maya/trips/june%20trip.page.md");
  assert.equal(noteLinkUrl(ORIGIN, "maya", "trips/page.md"), "https://app.example/note/@maya/trips/page.md");
  assert.equal(noteLinkUrl(ORIGIN, "maya", "trips/plan.PAGE.md"), "https://app.example/p/@maya/trips/plan.PAGE.md");
});

test("a page link they text is read as the note", () => {
  assert.deepEqual(sentNoteLinks("see https://app.example/p/@maya/trips/june%20trip.page.md", ORIGIN), [{ slug: "maya", path: "trips/june trip.page.md" }]);
  assert.deepEqual(sentNoteLinks("see https://app.example/p/@maya/../x.page.md", ORIGIN), []);
});

test("a failed write gets no link", async () => {
  const refused = { isError: true, content: [{ type: "text", text: "written: nothing (etag x)" }] };
  const call = withNoteLinks(async () => refused, { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("write_note", { path: "a.md" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /link:/);
});

test("a refused note call names the workspace that refused it (2026-11-17)", async () => {
  const refused = { isError: true, content: [{ type: "text", text: "Projects is already here, and names in one folder can't differ only by case. Use Projects/x.md instead." }] };
  const call = withNoteLinks(async () => refused, { origin: ORIGIN, contexts: CONTEXTS });
  assert.match((await call("write_note", { path: "projects/x.md" })).content[0].text, /^In @maya: Projects is already here/);
  assert.match((await call("write_note", { path: "projects/x.md", context: "@hangg" })).content[0].text, /^In @hangg: /);
  assert.equal(await call("search", { query: "x" }), refused, "other tools' refusals pass through");
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
  assert.doesNotMatch((await call("read_note", { path: "a.md" })).content[0].text, /link:/);
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

test("a read that names its workspace only in the path links into that workspace (Sayo's chat, 2026-11-16)", async () => {
  const read = { content: [{ type: "text", text: "etag: c2.x\npath: projects/plan.md\nvisibility: team\n\nbody" }] };
  const call = withNoteLinks(async () => read, { origin: ORIGIN, contexts: CONTEXTS });
  const result = await call("read_note", { path: "@hangg/projects/plan.md" });
  assert.match(result.content[0].text, /\nlink: https:\/\/app\.example\/note\/@hangg\/projects\/plan\.md/);
  assert.doesNotMatch(result.content[0].text, /@maya/);
});

/** A write_note result as the handler gives it: `created` says whether the save made the note (its activity hint). */
const saving = (path, { created = false, etag = "c1.new" } = {}) =>
  withActivityHint({ content: [{ type: "text", text: `written: ${path} (etag ${etag})\nvisibility: private` }] }, { created });

/** A wrapper over `write_note` results (or `reply`'s), with its own saved list. */
const savingCall = (result, saved = []) => ({
  saved,
  call: withNoteLinks(async () => result, { origin: ORIGIN, contexts: CONTEXTS, saved }),
});

test("a created plain note counts, and the reply that does not link it gets its link on its own line", async () => {
  const { call, saved } = savingCall(saving("1-projects/Supper club.md", { created: true }));
  await call("write_note", { path: "1-projects/Supper club.md", content: "x" });
  assert.deepEqual(saved, [{ slug: "maya", path: "1-projects/Supper club.md", url: "https://app.example/note/@maya/1-projects/Supper%20club.md" }]);
  assert.equal(withSavedLink("Here it is", saved, ORIGIN), "Here it is\nhttps://app.example/note/@maya/1-projects/Supper%20club.md");
  assert.equal(withSavedLink("Here it is\n\n", saved, ORIGIN), "Here it is\nhttps://app.example/note/@maya/1-projects/Supper%20club.md", "trailing space is trimmed before the link");
});

test("an update to an existing plain note does not count", async () => {
  const { call, saved } = savingCall(saving("topics/fact.md"));
  await call("write_note", { path: "topics/fact.md", content: "x", expected_etag: "c0" });
  assert.deepEqual(saved, []);
  assert.equal(withSavedLink("Here it is", saved, ORIGIN), "Here it is");
});

test("a page counts when it is updated, and its link is the page viewer's", async () => {
  const { call, saved } = savingCall(saving("trips/june trip.page.md"));
  await call("write_note", { path: "trips/june trip.page.md", content: "x", expected_etag: "c0" });
  assert.equal(saved[0]?.url, "https://app.example/p/@maya/trips/june%20trip.page.md");
});

test("remember, a failed write, Tex's own notes, comments and mail never count", async () => {
  const saved = [];
  const pass = withNoteLinks(async () => saving("tex/about.md", { created: true }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await pass("remember", { path: "1-projects/x.md", content: "x" });
  const failed = withNoteLinks(async () => ({ ...saving("1-projects/x.md", { created: true }), isError: true }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await failed("write_note", { path: "1-projects/x.md", content: "x" });
  const cases = [
    ["tex/about.md", { path: "tex/about.md", content: "x" }],
    ["tex/routines/daily/x.md", { path: "tex/routines/daily/x.md", content: "x" }],
    ["inbox/memories/x.md", { path: "inbox/memories/x.md", content: "x" }],
    ["a comment-only write", { path: "1-projects/x.md", comment: "looks good" }],
    ["a comment on a new note", { path: "1-projects/x.md", content: "x", comment: "hi" }],
    ["a mail write", { path: "1-projects/x.md", content: "x", mail: "new" }],
    ["a site write", { path: "1-projects/x.md", content: "x", site: "publish" }],
    ["a share write", { path: "1-projects/x.md", content: "x", share: "link" }],
  ];
  for (const [what, args] of cases) {
    const call = withNoteLinks(async () => saving(args.path, { created: true }), { origin: ORIGIN, contexts: CONTEXTS, saved });
    await call("write_note", args);
    assert.deepEqual(saved, [], `${what} is not a deliverable`);
  }
  assert.equal(withSavedLink("Got it", saved, ORIGIN), "Got it");
});

test("archiving or moving a saved note takes it back out", async () => {
  const saved = [];
  const writing = withNoteLinks(async () => saving("1-projects/plain.md", { created: true }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await writing("write_note", { path: "1-projects/plain.md", content: "x" });
  assert.equal(saved.length, 1);
  const archiving = withNoteLinks(async () => ({ content: [{ type: "text", text: "archived" }] }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await archiving("archive_note", { path: "/1-Projects/Plain.md" });
  assert.deepEqual(saved, [], "archive matches case-insensitively, leading slash stripped");
  await writing("write_note", { path: "1-projects/plain.md", content: "x" });
  const moving = withNoteLinks(async () => ({ content: [{ type: "text", text: "moved" }] }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await moving("move_note", { source: "1-projects/plain.md", destination: "2-areas/plain.md" });
  assert.deepEqual(saved, []);
});

test("a failed archive keeps the saved note", async () => {
  const saved = [{ slug: "maya", path: "a.md", url: "https://app.example/note/@maya/a.md" }];
  const refused = withNoteLinks(async () => ({ isError: true, content: [{ type: "text", text: "no" }] }), { origin: ORIGIN, contexts: CONTEXTS, saved });
  await refused("archive_note", { path: "a.md" });
  assert.equal(saved.length, 1);
});

test("the last saved note wins, one link only, and saving again moves it to the end", async () => {
  const saved = [];
  for (const path of ["a.md", "b.md", "a.md"]) {
    const call = withNoteLinks(async () => saving(path, { created: true }), { origin: ORIGIN, contexts: CONTEXTS, saved });
    await call("write_note", { path, content: "x" });
  }
  assert.deepEqual(saved.map((entry) => entry.path), ["b.md", "a.md"]);
  assert.equal(withSavedLink("Here", saved, ORIGIN), "Here\nhttps://app.example/note/@maya/a.md");
});

test("no second link when the reply already links the note: exact url, the /p/ or /note/ variant, or an encoded one", () => {
  const saved = [{ slug: "maya", path: "1-projects/Supper club.md", url: "https://app.example/note/@maya/1-projects/Supper%20club.md" }];
  for (const answer of [
    "Here it is: https://app.example/note/@maya/1-projects/Supper%20club.md",
    "Here it is: https://app.example/p/@maya/1-projects/Supper%20club.md",
    "Here it is https://app.example/console/@maya?note=1-projects/Supper%20club.md",
    "Here it is https://app.example/note/@maya/%31-projects/Supper%20club.md",
  ]) {
    assert.equal(withSavedLink(answer, saved, ORIGIN), answer, answer);
  }
});

test("a blank reply, no origin, or nothing saved leaves the reply as it was", () => {
  const saved = [{ slug: "maya", path: "a.md", url: "https://app.example/note/@maya/a.md" }];
  assert.equal(withSavedLink("   ", saved, ORIGIN), "   ");
  assert.equal(withSavedLink("Here", saved, null), "Here");
  assert.equal(withSavedLink("Here", [], ORIGIN), "Here");
  assert.equal(withSavedLink("Here", undefined, ORIGIN), "Here");
});
