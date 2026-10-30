/**
 * A PLAN SAVED AS A PLAIN NOTE (owner, 2026-10-27: "WHY THE HECK IS IT GIVING
 * ME A PLAIN MARKDOWN FOR THIS, THIS SHOULD HAVE BEEN A WELL DESIGNED PAGE").
 * Asked by text for a detailed concert plan, Tex saved a checklist as
 * `projects/100-person-concert/plan.md`; then "by default every note that tex
 * produces should be a page". A texted turn's new plain note goes back once
 * with the page design skill (`agent/pageNotice.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `wantsAPage` returning null always → "a plan saved as a plain note goes
 *     back to be a page" fails.
 *   The page check dropped from `claimCheck.js` → "the turn's watcher sends
 *     the plain plan back once" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { noteWrite, pageNotice, wantsAPage } from "../src/agent/pageNotice.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { PAGE_SKILL_STAMP } from "../src/pageSkill.js";
import { withActivityHint } from "../src/live/activityHint.js";

const PLAN = [
  "# 100-person concert in NYC: plan",
  "",
  "A 12-week plan, counting back from show day.",
  "",
  "## Decide first (week 1)",
  "- [ ] Purpose and feel",
  "- [ ] Date and a backup date",
  "- [ ] Lineup size",
  "",
  "## Venue (weeks 1-3)",
  "- [ ] Capacity 120-150",
  "- [ ] Hold the date with a deposit",
  "- [ ] Insurance",
  "",
].join("\n");
const QUESTION = "can you make a detailed plan for putting on a 100 person concert in nyc";

test("a plan saved as a plain note goes back to be a page", () => {
  const plain = noteWrite("write_note", { path: "projects/100-person-concert/plan.md", content: PLAN });
  assert.equal(wantsAPage([plain], QUESTION), "projects/100-person-concert/plan.md");
  // Written as a page, it stays.
  assert.equal(wantsAPage([plain, noteWrite("write_note", { path: "projects/100-person-concert/plan.page.md", content: PLAN })], QUESTION), null);
  // Records and Tex's own notes stay plain: a to-do list, memory, the inbox, a routine.
  for (const path of ["todo.md", "tex/about-me.md", "inbox/notes/plan.md", "tex/routines/daily/plan.md"]) {
    assert.equal(wantsAPage([noteWrite("write_note", { path, content: PLAN })], QUESTION), null, path);
  }
  // An update of a note they have (an etag passed) keeps its form.
  assert.equal(wantsAPage([noteWrite("write_note", { path: "projects/x/plan.md", content: PLAN, expected_etag: "e1" })], QUESTION), null);
  // An overwrite with no etag that the write itself says was not a new note keeps its form too.
  const overwrote = withActivityHint({ content: [{ type: "text", text: "written" }] }, { created: false });
  assert.equal(wantsAPage([noteWrite("write_note", { path: "projects/x/plan.md", content: PLAN }, overwrote)], QUESTION), null);
  // Every new note is a page by default (owner, 21:08), a short one too, unless they ask for a plain note.
  assert.equal(wantsAPage([noteWrite("write_note", { path: "areas/codes/door.md", content: "# Door code\n\n4412" })], "save the door code"), "areas/codes/door.md");
  for (const asked of ["save this as a plain note please", "make it a regular note", "just a markdown file, not a page"]) {
    assert.equal(wantsAPage([plain], asked), null, asked);
  }
  // The six-tool write reads the same; its other actions are not note saves.
  assert.equal(noteWrite("write", { path: "projects/a.md", content: PLAN }).path, "projects/a.md");
  assert.equal(noteWrite("write", { action: "remember", path: "projects/a.md", content: PLAN }), null);
});

test("the notice carries the skill and its stamp, and names the page to write", () => {
  const said = pageNotice("projects/100-person-concert/plan.md");
  assert.match(said, /projects\/100-person-concert\/plan\.page\.md/);
  assert.match(said, /archive_note/);
  assert.ok(said.includes(PAGE_SKILL_STAMP));
});

test("the turn's watcher sends the plain plan back once", async () => {
  const claims = claimCheck({ question: QUESTION });
  const call = claims.wrap(async () => ({ content: [{ type: "text", text: "Written." }] }));
  await call("write_note", { path: "projects/100-person-concert/plan.md", content: PLAN });
  const answer = "I made it a 12-week plan. Book the venue first. The full checklist is in your notes.";
  const first = await claims.check(answer);
  assert.match(String(first), /every new note you make is a designed page/);
  assert.doesNotMatch(String(await claims.check(answer)), /every new note you make is a designed page/, "asked once only");
});

test("what Tex makes for a guest chat in tex/chats/ goes back to be a page; the chat's memory note stays plain", () => {
  // 2026-10-28: a WhatsApp guest chat's research was saved plain twice and never sent back, its folder being under tex/.
  const research = "tex/chats/pearl-ivory-arrow/sunday-services-research.md";
  assert.equal(wantsAPage([noteWrite("write_note", { path: research, content: PLAN })], "put all this research into a page"), research);
  for (const path of ["tex/chats/pearl-ivory-arrow/chat-d63b31518206.md", "tex/chats/notes.md", "tex/groups/chat-d63b31518206.md"]) {
    assert.equal(wantsAPage([noteWrite("write_note", { path, content: PLAN })], QUESTION), null, path);
  }
});
