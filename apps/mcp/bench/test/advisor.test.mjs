/**
 * THE ADVISOR, ONE ROLE AT A TIME (`bench/advisor.mjs`, `src/agent/advisorRoles/`; Dev2, 2026-11-13).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `advisor-chat` counting a declined ask as right for an "advise" case -> "a decline is wrong where advice was wanted" fails;
 *  2. `saysRight` ignoring `never` -> "advice that names what it must not is wrong" fails;
 *  3. the job check's `ask` passing the case's answer as "" -> "every role's case is put as production puts it" fails;
 *  4. `adviseOnce` dropping `display: "summarized"` -> "every role asks the one way" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ROLES, fakeRequest, gateRows, loadRoleCases, roleReport, saysRight, scoreRole } from "../advisor.mjs";
import { rowsFor } from "../replayGate.mjs";
import { ADVISOR_PROMPT, advisorTools } from "../../src/agent/advisor.js";
import { adviseOnce } from "../../src/agent/advisorRoles/core.js";
import { JOB_CHECK_PROMPT } from "../../src/agent/jobCheck.js";
import { ADVISOR_MAIL_PROMPT, jobMailBrief } from "../../src/agent/jobNote.js";
import { PLANNER_PROMPT, planBrief } from "../../src/agent/planBigAsk.js";
import { withArchitecture } from "../../src/agent/texArchitecture.js";

test("every role has a case set of its own, with invented ids and a label each", async () => {
  for (const role of Object.keys(ROLES)) {
    const cases = await loadRoleCases(role);
    assert.ok(cases.length >= 3, `${role} has at least three cases`);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, `${role}'s ids are unique`);
    for (const item of cases) {
      assert.ok(item.id.startsWith(`${role}/`));
      if (role === "advisor-chat") assert.ok(["decline", "advise"].includes(item.want), item.id);
      if (role === "advisor-planner") assert.ok(["now", "one_job", "split"].includes(item.want), item.id);
      if (role === "advisor-job-check") assert.ok([item.want].flat().every((want) => ["done", "keep_going", "waiting", "stuck"].includes(want)), item.id);
      for (const pattern of [...(item.says ?? []), ...(item.never ?? [])]) assert.doesNotThrow(() => new RegExp(pattern, "i"), `${item.id}: ${pattern}`);
    }
  }
});

test("a stand-in that answers by the label gets every case right: the plumbing holds", async () => {
  for (const role of Object.keys(ROLES)) {
    const scored = await scoreRole(role, await loadRoleCases(role), (item) => fakeRequest(role, item));
    assert.deepEqual(scored.filter((item) => !item.right).map((item) => item.id), [], role);
  }
});

test("a decline is wrong where advice was wanted, and advice is wrong where a decline was", async () => {
  const cases = await loadRoleCases("advisor-chat");
  const flipped = (item) => fakeRequest("advisor-chat", { ...item, want: item.want === "decline" ? "advise" : "decline" });
  const scored = await scoreRole("advisor-chat", cases, flipped);
  assert.ok(scored.every((item) => item.right === false));
  // With nothing it must say, only the decline itself can make advice wrong.
  const bare = { id: "advisor-chat/bare", q: "plan it", want: "advise" };
  const [wrong] = await scoreRole("advisor-chat", [bare], () => fakeRequest("advisor-chat", { want: "decline" }));
  assert.equal(wrong.right, false);
});

test("advice that names what it must not is wrong", () => {
  const item = { says: ["tex"], never: ["\\$\\s?\\d"] };
  assert.equal(saysRight("No budget in the note; mail tex to ask.", item), true);
  assert.equal(saysRight("Use $60 a head, and mail tex.", item), false);
  assert.equal(saysRight("No budget in the note.", item), false, "every says pattern is needed");
});

test("every role asks the one way: its own instructions behind the drawing, no tools, its thinking summarized", async () => {
  const asked = [];
  const request = async (params) => (asked.push(params), { text: "VERDICT: done\nADVICE: ok." });
  await adviseOnce({ request, model: "m", effort: "high", prompt: "P", role: "planner", brief: "B" });
  assert.deepEqual(asked[0], { model: "m", system: withArchitecture("P", "planner"), messages: [{ role: "user", text: "B" }], tools: [], display: "summarized", effort: "high" });
  await adviseOnce({ request, model: "m", prompt: "P", role: "planner", brief: "B" });
  assert.equal("effort" in asked[1], false, "no effort named, none sent");
});

test("every role's case is put as production puts it: that role's instructions and its own brief", async () => {
  const seen = {};
  for (const role of Object.keys(ROLES)) {
    const [item] = await loadRoleCases(role);
    const request = async (params) => ((seen[role] = params), fakeRequest(role, item)());
    await ROLES[role].ask(item, request);
  }
  assert.equal(seen["advisor-chat"].system, withArchitecture(ADVISOR_PROMPT, "advisor"));
  assert.equal(seen["advisor-job-check"].system, withArchitecture(JOB_CHECK_PROMPT, "jobCheck"));
  assert.equal(seen["advisor-planner"].system, withArchitecture(PLANNER_PROMPT, "planner"));
  assert.equal(seen["advisor-job-mail"].system, withArchitecture(ADVISOR_MAIL_PROMPT, "jobAdvisor"));
  const check = (await loadRoleCases("advisor-job-check"))[0];
  assert.match(seen["advisor-job-check"].messages[0].text, new RegExp(check.answer.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the job's last words reach the check");
  const plan = (await loadRoleCases("advisor-planner"))[0];
  assert.equal(seen["advisor-planner"].messages[0].text, planBrief({ history: [], question: plan.q, ask: plan.q, slots: 3, cloud: 3, computers: [], freeOn: () => 0 }));
  const mail = (await loadRoleCases("advisor-job-mail"))[0];
  assert.equal(seen["advisor-job-mail"].messages[0].text, jobMailBrief({ ...mail.job, from: mail.from, noteText: mail.note, question: mail.question }));
  // The chat role reads the turn through `advisorTools`, the front door's own tool.
  const [tool] = advisorTools({ model: "m", history: [], question: "", request: async (params) => ((seen.direct = params), { text: "ok" }) });
  await tool.call({}, { about: "", now: "", tools: [], messages: [] });
  assert.equal(seen.direct.system, seen["advisor-chat"].system);
});

test("a role's rows are what the gate reads, and a held-out case is reported by its cause alone", async () => {
  const scored = [
    { id: "advisor-planner/a", right: true, expected: "say do it now", usd: 0.04 },
    { id: "held-out/secret-words", right: false, heldOut: true, cause: "splits a lookup", expected: "say do it now", got: "split", words: "secret words", usd: 0.04 },
  ];
  const rows = rowsFor("advisor-planner", gateRows(scored));
  assert.deepEqual(rows.map((row) => [row.id, row.right, row.heldOut, row.expected]), [["advisor-planner/a", true, false, "say do it now"], ["held-out/secret-words", false, true, "say do it now"]]);
  assert.equal(rows[1].got, undefined, "a held-out case's answer never reaches the gate's rows");
  assert.match(rowsFor("advisor-planner", gateRows([{ ...scored[0], right: false, got: "split", words: "dinners, day-trip" }]))[0].got, /split: dinners, day-trip/);
  const report = roleReport("advisor-planner", scored);
  assert.match(report, /1\/1 right/);
  assert.match(report, /wrong about splits a lookup/);
  assert.doesNotMatch(report, /secret/);
});
