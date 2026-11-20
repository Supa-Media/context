/**
 * Every code check reads a draft together, and it goes back once with all of
 * them (`checkFindings.js`; Dev2's "jobs as config" plan, 2026-11-17, part A).
 *
 * The timecards job of 2026-11-17: each part heard "make it a page", then
 * "that's an essay", then "one casual line", one round each, until the third
 * send-back crashed the part and its answer was lost. Sabotage:
 *   - `oneShape` keeping every shape advice → "page and essay advice never
 *     go back together" fails;
 *   - `combineFindings` letting advice go back alone in a job → "a job's part
 *     is never held for advice" fails;
 *   - `claimCheck`'s `check` returning only the first finding → "facts on the
 *     same draft go back in one notice" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SHAPE, carries, combineFindings, finding, oneShape } from "../../../packages/tex/gateway/agent/checkFindings.js";
import { claimCheck, CLAIM_NOTICE, HANDBACK_NOTICE } from "../../../packages/tex/gateway/agent/claimCheck.js";
import { doItChecks, ADVISOR_NOTICE } from "../../../packages/tex/gateway/agent/doItChecks.js";
import { ADVISOR_TOOL } from "../../../packages/tex/gateway/agent/advisor.js";
import { replyChecks } from "../../../packages/tex/gateway/agent/replyChecks.js";
import { WORK_PAGE_NOTICE } from "../../../packages/tex/gateway/agent/workPage.js";
import { WORDY_NOTICE, RESULT_NOTICE } from "../../../packages/tex/gateway/agent/wordy.js";
import { bareCoverNotice } from "../../../packages/tex/gateway/agent/pageCoverFloor.js";
import { GIVE_UP, GIVE_UPS } from "../../../packages/tex/gateway/agent/checkFindings.js";

/** Findings looked up on the web and texted as a long wall of words: a page's worth, and an essay. No figures, so nothing unsourced. */
const WALL = Array.from({ length: 14 }, (_, at) => `Finding ${at + 1} is that the venue market near the park is tight this month and books out early.`).join(" ");
const web = { tools: [{ name: "search_web" }], call: async () => ({ content: [{ type: "text", text: "results" }] }) };

async function searched(claims) {
  await claims.wrapWeb(web).call("search_web", { query: "venues" });
  return claims;
}

test("page and essay advice never go back together, and never one after the other", async () => {
  const claims = await searched(claimCheck({ question: "find us a venue for 30" }));
  const first = await claims.check(WALL);
  assert.equal(first, WORK_PAGE_NOTICE, "the page advice alone, word for word");
  assert.ok(!carries(first, WORDY_NOTICE), "never 'make it a page' and 'that's an essay' at once");
  // The rewrite is still long: no second shape round contradicts the first.
  const second = await claims.check(WALL);
  assert.ok(!carries(second, WORDY_NOTICE) && !carries(second, RESULT_NOTICE), String(second));
  assert.equal(second, null);
});

test("a job's part is never held for advice alone", async () => {
  const claims = await searched(claimCheck({ question: "find us a venue for 30", job: { id: "job-1" } }));
  assert.equal(await claims.check(WALL), null);
});

test("facts on the same draft go back in one notice, with advice riding along", async () => {
  const claims = await searched(claimCheck({ question: "find us a venue for 30", job: { id: "job-1" } }));
  const draft = `${WALL} I've added it to your notes. Can you check their site and forward me the menu?`;
  const notice = await claims.check(draft);
  assert.ok(carries(notice, CLAIM_NOTICE), "the claim with no write");
  assert.ok(carries(notice, HANDBACK_NOTICE), "the look-up handed back");
  assert.ok(carries(notice, WORK_PAGE_NOTICE), "the page advice rides along");
  assert.match(notice, /^Before this goes, check 2 things/);
  assert.match(notice, /never a reason to hold the answer back/);
  // Each was said once: the same draft goes, nothing is sent back a second time.
  assert.equal(await claims.check(draft), null);
});

test("one finding goes back word for word", () => {
  assert.equal(combineFindings([finding("claim", CLAIM_NOTICE)]), CLAIM_NOTICE);
  assert.equal(combineFindings([finding("work", WORK_PAGE_NOTICE, true)]), null, "advice alone holds nothing back");
  assert.equal(combineFindings([finding("work", WORK_PAGE_NOTICE, true)], { adviceAlone: true }), WORK_PAGE_NOTICE);
  assert.equal(combineFindings([]), null);
});

test("only one form-or-length advice is kept, the first in SHAPE's order", () => {
  const found = [finding("wordy", WORDY_NOTICE, true), finding("work", WORK_PAGE_NOTICE, true), finding("cover", "draw the cover", true), finding("claim", CLAIM_NOTICE)];
  assert.deepEqual(oneShape(found).map((entry) => entry.kind), ["work", "cover", "claim"]);
  assert.deepEqual(oneShape(found, true).map((entry) => entry.kind), ["cover", "claim"], "none once one was given");
  assert.ok(SHAPE.indexOf("work") < SHAPE.indexOf("wordy") && SHAPE.indexOf("result") < SHAPE.indexOf("wordy"));
});

test("the reply checks on their own send a page or an essay notice, never both", () => {
  const check = replyChecks({ question: "find us a venue for 30" });
  const steps = [{ name: "search_web", ok: true }];
  assert.equal(check(WALL, steps), WORK_PAGE_NOTICE);
  assert.equal(check(WALL, steps), null);
});

test("the advisor's ask goes back in the same notice as the claim check's findings", async () => {
  const claims = claimCheck({ question: "ask your advisor and add it to my notes" });
  const doIt = doItChecks({ question: "ask your advisor and add it to my notes", inner: claims });
  doIt.wrapLocal([{ tool: { name: ADVISOR_TOOL }, call: async () => ({}) }]);
  const notice = await doIt.check("Done, I've added it to your notes.");
  assert.ok(carries(notice, ADVISOR_NOTICE) && carries(notice, CLAIM_NOTICE), notice);
});

test("a bare page's cover still holds a job's answer: it is a fact (pages.md, 'A page always has a picture')", async () => {
  const claims = claimCheck({ question: "find new church plants", job: { id: "job-1" } });
  await claims.wrap(async () => ({ content: [{ type: "text", text: "saved" }] }))("write_note", { path: "projects/churches.page.md", content: "---\nkind: research\n---\n# Churches\n\nEight plants." });
  const notice = await claims.check("Eight plants. https://context.lc/p/@seyi/projects/churches.page.md");
  assert.ok(carries(notice, bareCoverNotice("projects/churches.page.md")), String(notice));
});

test("advice a job didn't send is not spent: it rides along with a later fact", async () => {
  const claims = await searched(claimCheck({ question: "find us a venue for 30", job: { id: "job-1" } }));
  assert.equal(await claims.check(WALL), null);
  const notice = await claims.check(`${WALL} I've added it to your notes.`);
  assert.ok(carries(notice, CLAIM_NOTICE) && carries(notice, WORK_PAGE_NOTICE), String(notice));
});

test("a fact that sets the answer's shape sends no shape advice beside it", () => {
  const found = [finding("owed-picture", "draw it, then ONE line"), finding("wordy", WORDY_NOTICE, true)];
  assert.deepEqual(oneShape(found).map((entry) => entry.kind), ["owed-picture"]);
});

test("at most two give-up facts go back on one draft, the most exact first", () => {
  const found = ["handback", "routes", "paste", "sites", "claim"].map((kind) => finding(kind, `Before this goes: ${kind}.`));
  const kept = oneShape(found).map((entry) => entry.kind);
  assert.deepEqual(kept, ["paste", "sites", "claim"]);
  assert.equal(kept.filter((kind) => GIVE_UP.includes(kind)).length, GIVE_UPS);
});
