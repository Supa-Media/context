/**
 * ONE CHECKED ACCOUNT OF A SAVE, AND NO MADE-UP CAUSE (`src/agent/saveAccount.js`).
 *
 * The case (Tex Devs, 2026-10-29, @context-lc areas/tex-reviews/themes/page-save-fails.md):
 *
 *   Tex:  I couldn't save the page update. The workspace stopped responding mid-save … Here's the bug report I'd send.
 *   Tex:  The save went through after all, so you can drop that bug report.
 *   Them: you said you couldn't save it, but literally sent it right after
 *   Tex:  Fair catch. I said I couldn't save it, then signed in anyway with the code.   (only earlier_chat ran)
 *
 * Sabotage (temporary local edits, reverted):
 *  - `uncheckedFailedSave` returning null: "a failed save is read back before it is told" fails;
 *  - `inventedSignIn` returning false: "a sign-in nobody ran is not given as the cause" fails;
 *  - `noteStep` returning {}: "a failed save is read back before it is told" fails (no note on the steps).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { inventedSignIn, uncheckedFailedSave } from "../src/agent/saveAccount.js";

const PAGE = "resources/engineering/cheap-reasoning-models.page.md";
const FAILED = "I couldn't save the page update. The workspace stopped responding mid-save. I've written up a bug report.";
const ok = { content: [{ type: "text", text: "Saved." }] };
const refused = { content: [{ type: "text", text: "this workspace's file list could not be read just now; try again in a moment." }], isError: true };

test("a failed save is read back before it is told", async () => {
  const claims = claimCheck({ question: "check arena.ai and AA for these models", job: { title: "Agentic benchmarks" } });
  const call = claims.wrap(async (name) => (name === "write_note" ? refused : ok));
  await call("write_note", { path: PAGE, content: "# Models", context: "@team" });
  const notice = await claims.check(FAILED);
  assert.match(String(notice), /haven't read it back/);
  assert.match(String(notice), /read_note/);
  assert.match(String(notice), /no bug report/);
  // Once read back, the model's account goes as it is.
  await call("read_note", { path: PAGE, context: "@team" });
  assert.equal(uncheckedFailedSave(FAILED, [
    { name: "write_note", ok: false, write: true, note: `@team:${PAGE}` },
    { name: "read_note", ok: true, note: `@team:${PAGE}` },
  ]), null);
});

test("a save a later write fixed is told as saved", () => {
  const steps = [
    { name: "write_note", ok: false, write: true, note: `:${PAGE}` },
    { name: "write_note", ok: true, write: true, note: `:${PAGE}` },
  ];
  assert.deepEqual(uncheckedFailedSave("The save failed, sorry.", steps), { path: PAGE, saved: true });
});

test("plain answers and failures elsewhere pass", () => {
  const failedWrite = [{ name: "write_note", ok: false, write: true, note: `:${PAGE}` }];
  assert.equal(uncheckedFailedSave("Saved it: here's the page.", failedWrite), null, "no failure told");
  assert.equal(uncheckedFailedSave(FAILED, []), null, "no failed save on record");
  assert.equal(uncheckedFailedSave(FAILED, [{ name: "search_web", ok: false }]), null, "a failed search is not a save");
  assert.equal(uncheckedFailedSave("It wasn't saved.", [{ name: "write_note", ok: false, write: true, note: `:other.md` }, { name: "read_note", ok: true, note: `:other.md` }]), null);
});

test("a sign-in nobody ran is not given as the cause", async () => {
  const history = [
    { role: "assistant", text: FAILED, tools: ["read_note", "orient", "search_web", "open_page"] },
    { role: "assistant", text: "The save went through after all.", tools: ["read_note", "search_web", "open_page", "write_note"] },
  ];
  const caught = "Fair catch. I said I couldn't save it, then signed in anyway with the code.";
  assert.equal(inventedSignIn(caught, { history, steps: [{ name: "earlier_chat", ok: true }] }), true);

  const claims = claimCheck({ question: "you said you couldn't save it, but literally sent it right after", history });
  const call = claims.wrap(async () => ok);
  await call("earlier_chat", {});
  const notice = await claims.check(caught);
  assert.match(String(notice), /nothing on your record did/);
  assert.match(String(notice), /say you don't know why/);

  // A sign-in that really ran can be told.
  assert.equal(inventedSignIn("I signed in with the code you sent.", { history: [{ role: "assistant", text: "x", tools: ["fill_login"] }] }), false);
  assert.equal(inventedSignIn("Signed in with your saved login.", { steps: [{ name: "browse", ok: true }] }), false);
  assert.equal(inventedSignIn("The save worked the second time; the first one failed.", { history }), false);
});
