/**
 * TEX'S JOB TASKS, RUN END TO END AND GRADED IN CODE (`bench/jobTasks.mjs`; Dev2, 2026-11-13).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `checkTask` dropping the sources check -> "a page without its sources fails" fails;
 *  2. `runJob` not carrying the check's advice into the next part -> "a part the check says isn't finished is followed
 *     by another, on its advice" fails;
 *  3. `endedAs` reading keep_going on the last part as done -> "a job still not finished when its parts run out ends
 *     stuck" fails;
 *  4. `pickPage` taking a placed page nobody rewrote -> "a page edit that never saved has no page" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkTask, endedAs, gateRow, hasEntry, loadCases, pickPage, readQuality, runJob, sourcesIn } from "../jobTasks.mjs";

const caterers = {
  id: "t",
  text: "compare caterers",
  job: { title: "Caterers", brief: "b", doneWhen: "d" },
  page: { under: "maya/" },
  sources: { hosts: ["caterers.example"], min: 2 },
  covers: ["Lucky Wok", "4,000|4000"],
};
const checked = [{ checked: true }];

test("a page that cites its sources and covers every part of the ask passes every check", () => {
  const page = { path: "maya/p.md", text: "Lucky Wok $4000 https://caterers.example/lucky-wok and caterers.example/rosa." };
  const checks = checkTask(caterers, { page, status: "done", parts: checked });
  assert.deepEqual(checks.filter((check) => !check.pass), []);
});

test("a page without its sources fails", () => {
  const page = { path: "maya/p.md", text: "Lucky Wok $4,000." };
  const failed = checkTask(caterers, { page, status: "done", parts: checked }).filter((check) => !check.pass).map((check) => check.line);
  assert.deepEqual(failed, ["cites 2+ sources on caterers.example (found 0)"]);
});

test("no page, a dropped part, a lost line, a missed site step, an unfinished end and an unchecked part each fail", () => {
  assert.equal(checkTask(caterers, { page: null, status: "done", parts: checked })[0].pass, false);
  const edit = { ...caterers, sources: { hosts: [], min: 0 }, keeps: ["# Plan"], absent: ["$200"], site: ["set registered"] };
  const failed = checkTask(edit, { page: { path: "x", text: "Lucky Wok, was $200" }, status: "stuck", browser: ["open retreat.example/register"], parts: [{ checked: false }] })
    .filter((check) => !check.pass)
    .map((check) => check.line);
  assert.deepEqual(failed, ['covers "4,000|4000"', 'no longer says "$200"', 'keeps "# Plan"', "site: set registered", "ended done (ended stuck)", "the done check read every part"]);
});

test("sources are counted once per page, with or without the scheme, and only on the named hosts", () => {
  const text = "https://caterers.example/a, caterers.example/a. www.caterers.example/b (https://other.example/c)";
  assert.deepEqual(sourcesIn(text, ["caterers.example"]).sort(), ["caterers.example/a", "caterers.example/b"]);
  assert.equal(hasEntry("Sunday $6,500", "6,500|6500"), true);
  assert.equal(hasEntry("nothing", "6,500|6500"), false);
});

test("a job ends as the Worker ends it", () => {
  assert.equal(endedAs([{ ok: true, verdict: "done" }]), "done");
  assert.equal(endedAs([{ ok: true, verdict: null, unfinished: false }]), "done", "no verdict and no phrase: the Worker counts it done");
  assert.equal(endedAs([{ ok: true, verdict: "waiting" }]), "waiting");
  assert.equal(endedAs([{ ok: true, verdict: "stuck" }]), "stuck");
  assert.equal(endedAs([{ ok: false }]), "failed");
  assert.equal(endedAs([]), "failed");
});

function scriptedWorld(verdicts) {
  const asked = [];
  return {
    asked,
    modelCalls: () => asked.map(() => ({ messages: [{ content: "Is the job finished?" }] })),
    async text(message, _attachments, { job }) {
      asked.push(job);
      const verdict = verdicts[asked.length - 1];
      return { ok: true, answer: `part ${job.attempt} words`, verdict, advice: verdict === "keep_going" ? `next ${job.attempt}` : "", unfinished: verdict === "keep_going", tools: [], ms: 1, usageByModel: {} };
    },
  };
}

test("a part the check says isn't finished is followed by another, on its advice", async () => {
  const world = scriptedWorld(["keep_going", "keep_going", "done"]);
  const ran = await runJob(world, caterers, { maxParts: 4 });
  assert.equal(ran.status, "done");
  assert.deepEqual(world.asked.map((job) => job.attempt), [1, 2, 3]);
  assert.equal(world.asked[0].advice, undefined);
  assert.equal(world.asked[2].advice, "next 2");
  assert.equal(world.asked[2].draft, "part 2 words");
  assert.deepEqual(world.asked[0].asked, ["compare caterers"], "the check reads their own words, as the Worker sends them");
  assert.equal(ran.parts.every((part) => part.checked), true);
});

test("a job still not finished when its parts run out ends stuck", async () => {
  const ran = await runJob(scriptedWorld(["keep_going", "keep_going", "keep_going"]), caterers, { maxParts: 2 });
  assert.equal(ran.parts.length, 2);
  assert.equal(ran.status, "stuck");
});

test("a page edit that never saved has no page; a new page is the written note that covers most of the ask", () => {
  const placed = { "plan.page.md": "old" };
  const edit = { ...caterers, page: { at: "maya/plan.page.md" } };
  assert.equal(pickPage(edit, [], () => "old", placed), null);
  assert.deepEqual(pickPage(edit, [], () => "new", placed), { path: "maya/plan.page.md", text: "new" });
  const changes = [
    { workspace: "maya", path: "a.md", kind: "written" },
    { workspace: "maya", path: "b.md", kind: "written" },
    { workspace: "maya", path: "tex/history.md", kind: "written" },
  ];
  const texts = { "a.md": "Lucky Wok", "b.md": "Lucky Wok 4000", "tex/history.md": "Lucky Wok 4000 4000" };
  assert.equal(pickPage(caterers, changes, (path) => texts[path] ?? null).path, "maya/b.md");
});

test("the quality judge's lines are read by number, and a skipped one is a fail", () => {
  const grades = readQuality(["a", "b", "c"], "1: PASS\n2: FAIL - left out Ferry House\n");
  assert.deepEqual(grades.map((grade) => grade.pass), [true, false, false]);
  assert.equal(grades[1].why, "left out Ferry House");
});

test("every job task is invented, complete and gradeable", async () => {
  const cases = await loadCases();
  assert.ok(cases.length >= 6 && cases.length <= 8, "6-8 tasks (the coordinator's brief)");
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const item of cases) {
    assert.ok(item.text && item.job?.title && item.job?.brief && item.job?.doneWhen, `${item.id}: an ask, a title, a brief and a finish line`);
    assert.ok(item.page?.under || item.page?.at, `${item.id}: where its page is`);
    assert.ok((item.covers ?? []).length > 0, `${item.id}: what the page must answer`);
    assert.ok((item.quality ?? []).length > 0, `${item.id}: what the judge grades`);
    if (item.page.at) assert.ok(item.places?.[item.page.at.slice(item.page.at.indexOf("/") + 1)], `${item.id}: the page it edits is placed first`);
  }
  for (const kind of ["research page", "page edit", "errand"]) assert.ok(cases.some((item) => item.kind === kind), `a ${kind} task`);
  assert.deepEqual(gateRow({ id: "x", right: true, target: "a bug", usd: 0.3 }), { id: "x", right: true, must: false, heldOut: false, target: "a bug", cause: "a bug", expected: "finish with every check passing", usd: 0.3 });
  assert.equal(gateRow({ id: "y", right: false, target: false }).cause, null, "a case that is no target has no cause to name");
});
