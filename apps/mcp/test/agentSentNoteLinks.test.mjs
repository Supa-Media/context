/**
 * A note link they text is the note, and a call is found from the meetings
 * list (owner's report, 2026-10-21: Tex answered a pasted context.lc link of
 * yesterday's meeting with "the picture is just a hashtag icon", and the last
 * meeting with a colleague from an August note).
 *
 * ## Sabotage record
 *
 *   `sentNoteLinks` not checking the host
 *     → "only this deployment's own links are notes" fails
 *   the `..` segment check dropped
 *     → "a link that climbs out of the bucket is not a note" fails
 *   `MEETINGS_LINE` left out of a texted prompt
 *     → "a texted turn is told to answer a call from the meetings list" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sentNoteLinks, sentNoteLinksLine } from "../src/agent/noteLinks.js";
import { MEETINGS_LINE, systemPrompt } from "../src/agent/prompt.js";

const ORIGIN = "https://context.lc";

test("both shapes of a note link name the note they point at", () => {
  assert.deepEqual(sentNoteLinks("https://context.lc/note/@kofi/2-areas/meetings/1%3A1s/ada%3Akofi/untitled-2026-10-20.md", ORIGIN), [
    { slug: "kofi", path: "2-areas/meetings/1:1s/ada:kofi/untitled-2026-10-20.md" },
  ]);
  assert.deepEqual(
    sentNoteLinks("I LITERALLY just pasted it https://context.lc/console/@public-worship?note=2-areas%2Fmeetings%2Fada.md.", ORIGIN),
    [{ slug: "public-worship", path: "2-areas/meetings/ada.md" }],
  );
});

test("only this deployment's own links are notes", () => {
  assert.deepEqual(sentNoteLinks("https://evil.example/note/@kofi/a.md", ORIGIN), []);
  assert.deepEqual(sentNoteLinks("https://context.lc.evil.example/note/@kofi/a.md", ORIGIN), []);
  assert.deepEqual(sentNoteLinks("https://context.lc/pricing", ORIGIN), []);
  assert.deepEqual(sentNoteLinks("https://context.lc/note/@kofi/a.md", null), [], "no origin, no links");
});

test("a link that climbs out of the bucket is not a note", () => {
  assert.deepEqual(sentNoteLinks("https://context.lc/note/@kofi/%2e%2e/secret.md", ORIGIN), []);
  assert.deepEqual(sentNoteLinks("https://context.lc/console/@kofi?note=../x.md", ORIGIN), []);
  assert.deepEqual(sentNoteLinks("https://context.lc/note/kofi/a.md", ORIGIN), [], "the context needs its @");
});

test("the turn is told to read the linked note with fetch, and to ignore its preview picture", () => {
  const line = sentNoteLinksLine("https://context.lc/note/@kofi/2-areas/ada.md", ORIGIN);
  assert.match(line, /fetch id "2-areas\/ada\.md" with context "@kofi"/);
  assert.match(line, /never in the browser/);
  assert.match(line, /preview card/);
  assert.equal(sentNoteLinksLine("no links here", ORIGIN), "");
});

test("a texted turn is told to answer a call from the meetings list", () => {
  assert.ok(systemPrompt(null, { texting: true }).includes(MEETINGS_LINE));
  assert.ok(systemPrompt(null, { texting: true, notes: { prompt: "You are Tex." } }).includes(MEETINGS_LINE), "a setup's own words keep it");
  assert.match(MEETINGS_LINE, /fetch id "meetings:" first/);
  assert.match(MEETINGS_LINE, /newest first/);
  assert.match(MEETINGS_LINE, /at most once/);
  assert.ok(!systemPrompt(null, { texting: false }).includes(MEETINGS_LINE));
});
