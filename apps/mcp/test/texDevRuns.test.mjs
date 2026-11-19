/**
 * `tex_dev` `run` and `runs` (`src/texDev/tool.js`; Dev2, 2026-11-16: the Lab's Run Dev set, Run this chat, Run node
 * and its Runs panel, as MCP actions: Lab = MCP parity), and the workflow's halves around the node-alone runner
 * (`scripts/tex-lab-run.mjs`): which Dev conversations a run covers, and the results it reports.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   tool.js run without the needDraft check         "run sends the draft ..." fails
 *   devConversations keeping a draft moved to Training "the Dev set is the repo's ..." fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../src/texDev/tool.js";
import { guideText } from "../src/texDev/guide.js";
import { texDevToolDefinitions } from "../src/tools/schemas/texDev.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeople } from "../bench/load.mjs";
import { brokenRun, detailOf, devConversations, handoffOf, resultsOf, roundsLine, routeLine, routeOf, trainingConversations, uncast, unrun, worldOf } from "../../../scripts/tex-lab-run.mjs";
import { decideSaid, scoreByRepeat } from "../bench/setsRun.mjs";
import { createRequire } from "node:module";
const { CC_FIDELITY, CC_FIDELITY_WHY } = createRequire(import.meta.url)("../../../packages/shared/src/texRunBand.cjs");

const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const tool = (answers) => {
  const calls = [];
  const controlPlane = { async texDev(token, action, args) { calls.push({ action, args }); const a = answers[action]; return typeof a === "function" ? a(args) : (a ?? null); } };
  return { calls, call: createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session: { accessToken: "tok" }, controlPlane }) };
};

test("the guide, the schema's description and its action list name run and runs", () => {
  for (const action of ["run", "runs", "run_remove", "code"]) {
    assert.match(guideText(), new RegExp(`- ${action} `));
    const def = texDevToolDefinitions()[0];
    assert.match(def.description, new RegExp(`\\b${action}\\b`));
    assert.match(def.inputSchema.properties.action.description, new RegExp(`\\b${action}\\b`));
  }
});

test("run sends the draft, kind, chat, node and models, main by default, and refuses a malformed draft", async () => {
  const { calls, call } = tool({ run: { status: "ok", id: "k1" } });
  assert.equal(jsonOf(await call("run", {})).run, "k1");
  assert.deepEqual(calls[0], { action: "run", args: { draft: "main", kind: "dev", conv: undefined, node: undefined, models: "gw" } });
  await call("run", { draft: "vabc", kind: "chat", conv: "group-4", models: "cc" });
  assert.deepEqual(calls[1].args, { draft: "vabc", kind: "chat", conv: "group-4", node: undefined, models: "cc" });
  assert.equal((await call("run", { draft: "../x" })).isError, true);
  assert.equal(calls.length, 2);
});

test("run says the control plane's refusal; runs lists, and runs { id } answers one run whole", async () => {
  const { call } = tool({ run: { status: "bad_request", error: "you already have 3 runs waiting or running (at most 3)" }, runs: (a) => (a.id ? { status: "ok", run: { id: a.id, stage: "done", results: { rows: [] } } } : { status: "ok", runs: [{ id: "k1" }] }) });
  const refused = await call("run", { kind: "dev" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /at most 3/);
  assert.deepEqual(jsonOf(await call("runs", {})), { runs: [{ id: "k1" }] });
  const { byRoute, ...one } = jsonOf(await call("runs", { id: "k1" }));
  assert.deepEqual(one, { id: "k1", stage: "done", results: { rows: [] } });
  assert.equal(byRoute.any, false, "a run with no route data says so");
});

test("the Dev set is the repo's with the Lab's drafts over it; never Training", () => {
  const conv = (id, set, text = "hi") => ({ id, set, kind: "one", msgs: [{ id: "m1", who: "Jo", text }] });
  const repo = [conv("a", "dev"), conv("b", "dev"), conv("t", "training")];
  const drafts = [
    { id: "a", set: "dev", removed: false, conv: JSON.stringify(conv("a", "dev", "edited")) },
    { id: "b", set: "training", removed: false },
    { id: "n", set: "dev", removed: false, conv: JSON.stringify(conv("n", "dev")) },
    { id: "t", set: "training", removed: false },
  ];
  const got = devConversations(repo, drafts);
  assert.deepEqual(got.map((c) => c.id), ["a", "n"]);
  assert.equal(got[0].msgs[0].text, "edited");
  assert.deepEqual(devConversations(repo, [], "b").map((c) => c.id), ["b"]);
  assert.deepEqual(devConversations(repo, [], "t"), [], "a Training chat is never run");
});

test("a Training run is the repo's Training set, less what the Lab moved to Dev or removed; never Dev", () => {
  const conv = (id, set) => ({ id, set, kind: "one", msgs: [{ id: "m1", who: "Jo", text: "hi" }] });
  const repo = [conv("d", "dev"), conv("t1", "training"), conv("t2", "training"), conv("t3", "training")];
  const drafts = [
    { id: "t2", set: "dev", removed: false, conv: "{}" },
    { id: "t3", set: "training", removed: true },
  ];
  assert.deepEqual(trainingConversations(repo, drafts).map((c) => c.id), ["t1"]);
  assert.deepEqual(trainingConversations(repo, [], "t3").map((c) => c.id), ["t3"]);
  assert.deepEqual(trainingConversations(repo, [], "d"), [], "a Dev chat is never in a Training run");
});

// Lab run v57nzej7ky4nwymkc5txz7vsd18jfj16 (2026-11-17): Training's Front door read 0/63 in thirty seconds, every row
// "has no bench world", and the run was "done". Sabotage: make `uncast` or `unrun` return [] and these fail.
const LAB_RUN = new URL("../../../scripts/tex-lab-run.mjs", import.meta.url).pathname;
const PEOPLE = parsePeople(readFileSync(new URL("../bench/ai/workspaces/people.md", import.meta.url), "utf8"));
const fdChat = (id, members, kind = "one") => ({ id, set: "training", kind, members, msgs: [{ id: "m1", who: members[0], text: "hi", labels: { fd: { must: ["say hi"], star: true } } }] });

test("a run names the conversations whose Front door tests the bench has no world for, only when the Front door runs", () => {
  const convs = [fdChat("a", ["Maya"]), fdChat("b", ["Zed"]), fdChat("c", ["Maya", "Kofi"], "group"), { ...fdChat("d", ["Zed"]), msgs: [{ id: "m1", who: "Zed", text: "hi" }] }];
  assert.deepEqual(uncast(convs, PEOPLE), [
    { id: "b", problems: ["Zed has no bench world"] },
    { id: "c", problems: ["no shared workspace has all of Maya, Kofi"] },
  ], "a chat with no Front door test is not held to the cast");
  assert.deepEqual(uncast(convs, PEOPLE, "fd").map((x) => x.id), ["b", "c"]);
  assert.deepEqual(uncast(convs, PEOPLE, "decide"), [], "a Decide-only run needs nobody's world");
});

test("a step whose tests all could not run is named with its first reason; one that ran some is not", () => {
  const rows = [
    { node: "fd", ran: false, right: false, why: "Zed has no bench world" },
    { node: "fd", ran: false, right: false, why: "another" },
    { node: "decide", ran: true, right: false },
    { node: "decide", ran: false, right: false, why: "x" },
  ];
  assert.deepEqual(unrun(rows), [{ node: "fd", total: 2, why: "Zed has no bench world" }]);
  assert.deepEqual(unrun(rows.slice(2)), []);
  assert.deepEqual(unrun([]), []);
});

test("the workflow's halves fail, with why for the Lab, when the cast has no world or a whole step did not run", () => {
  const dir = mkdtempSync(join(tmpdir(), "tex-lab-run-"));
  const why = join(dir, "why");
  const run = (...args) => spawnSync(process.execPath, [LAB_RUN, ...args], { encoding: "utf8", env: { ...process.env, TEX_LAB_WHY: why } });
  writeFileSync(join(dir, "rows.json"), JSON.stringify([{ chat: "trial-hire", node: "fd", ran: false, right: false, why: "Zed has no bench world" }, { chat: "g", node: "decide", ran: true, right: true }]));
  const none = run("ran", join(dir, "rows.json"));
  assert.equal(none.status, 1);
  assert.match(none.stderr, /tex-lab-run: none of these steps' tests could run: fd 0\/1/);
  assert.doesNotMatch(none.stderr, /Zed/, "the public log keeps to steps and counts");
  assert.equal(readFileSync(why, "utf8"), "none of fd's 1 tests could run: Zed has no bench world");
  writeFileSync(join(dir, "ok.json"), JSON.stringify([{ node: "fd", ran: true, right: false }, { node: "fd", ran: false, right: false, why: "a picture" }]));
  assert.equal(run("ran", join(dir, "ok.json")).status, 0, "a test that can't run alone is its row's to say");
  // The repo's own Training set is cast from the bench, so its run prepares.
  writeFileSync(join(dir, "job.json"), JSON.stringify({ kind: "set", set: "training", models: "gw", drafts: [] }));
  const out = execFileSync(process.execPath, [LAB_RUN, "prepare", join(dir, "job.json"), join(dir, "lab")], { encoding: "utf8" });
  assert.match(out, /^Training conversations: 6 /);
  // A Dev draft from the Lab with someone the bench has no world for is refused before anything runs.
  const draft = { ...fdChat("stranger", ["Zed"]), set: "dev" };
  writeFileSync(join(dir, "job2.json"), JSON.stringify({ kind: "set", models: "gw", drafts: [{ id: "stranger", set: "dev", removed: false, conv: JSON.stringify(draft) }] }));
  const refused = run("prepare", join(dir, "job2.json"), join(dir, "lab2"));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 Dev conversation can't run the Front door's tests \(stranger\)/);
  assert.doesNotMatch(refused.stderr, /Zed/);
  assert.match(readFileSync(why, "utf8"), /^the Front door's tests can't run: stranger: Zed has no bench world/);
});

test("results count by chat and by step, with each test's verdict and no words", () => {
  const rows = [
    { chat: "g", msg: "m3", at: 2, node: "decide", right: true, ran: true, usd: 0.0004, got: "respond", want: "respond" },
    { chat: "g", msg: "m9", at: 8, node: "decide", right: false, ran: true, usd: 0.0004, got: "quiet", want: "respond", why: "act quiet, wanted respond" },
    { chat: "m", msg: "m2", at: 1, node: "fd", right: false, ran: false, usd: 0, why: "runs alone only on a one-ask chat" },
  ];
  const r = resultsOf(rows, "1200");
  // A row that could not run is out of the score (Dev2, 2026-11-18: a ran:false row counted as Tex's miss in v57mf0),
  // so the ran:false fd row no longer counts in total, perConv or perNode. Before this, total was 3.
  assert.deepEqual([r.pass, r.total, r.costUsd, r.ms], [1, 2, 0.0008, 1200]);
  assert.deepEqual(r.handoff, { jobs: 0, parts: 0, advisorCalls: 0, usd: 0, perJobUsd: 0, advisorCallsPerJob: 0 }, "no hand-off, all zero");
  assert.deepEqual(r.perConv, [{ id: "g", pass: 1, total: 2, min: 1, max: 1 }], "a conversation whose only row could not run is absent");
  assert.deepEqual(r.perNode, [{ node: "decide", pass: 1, total: 2, min: 1, max: 1 }]);
  assert.deepEqual(r.couldNotRun, [{ convId: "m", msgIndex: 1, node: "fd", why: "runs alone only on a one-ask chat" }]);
  assert.deepEqual(r.ambiguous, []);
  assert.equal(r.goldFails, null, "no gold report, no gold count");
  assert.deepEqual(r.rows[1], { convId: "g", msgIndex: 8, node: "decide", ok: false, got: "quiet", want: "respond", usd: 0.0004, tags: [] }, "a failing row carries its tags (none match here)");
  assert.deepEqual(r.rows[2], { convId: "m", msgIndex: 1, node: "fd", ok: false, got: "can't run: runs alone only on a one-ask chat", want: "", ran: false, usd: 0 }, "a test that did not run says why, and stays listed");
});

test("scoring tags a failing or flaky row from its conversation message; passing rows get no tags key; pass, total and score do not change with convs", () => {
  const rows = [
    { chat: "k", at: 0, node: "fd", right: false, ran: true, usd: 0, got: "quiet", want: "respond", misses: [{ kind: "must", line: "say where it is and confirm it saved", reason: "x" }] },
    { chat: "k", at: 1, node: "fd", right: true, ran: true, usd: 0, got: "ok", want: "ok" },
  ];
  const convs = [{ id: "k", msgs: [{ via: "checkin", text: "hi" }, { text: "yo" }] }];
  const withConvs = resultsOf(rows, "1", null, { convs });
  assert.deepEqual(withConvs.rows[0].tags, ["missed_checkin", "didnt_act"]);
  assert.equal("tags" in withConvs.rows[1], false, "a passing row has no tags key");
  const without = resultsOf(rows, "1");
  assert.deepEqual(without.rows[0].tags, ["didnt_act"], "without convs the message is unknown, so no check-in tag");
  assert.deepEqual([without.pass, without.total, without.score], [withConvs.pass, withConvs.total, withConvs.score]);
  assert.deepEqual(without.rows[0], { ...withConvs.rows[0], tags: ["didnt_act"] }, "nothing else in the row changes");
});

test("a row that could not run is out of total, pass, perConv and perNode, and listed in couldNotRun with its why", () => {
  const rows = [
    { chat: "a", at: 1, node: "fd", right: true, ran: true, usd: 0 },
    { chat: "a", at: 3, node: "fd", right: false, ran: false, usd: 0, why: "Zed has no bench world" },
    { chat: "b", at: 2, node: "decide", right: false, ran: false, usd: 0, why: "x".repeat(300) },
  ];
  const r = resultsOf(rows, "1");
  assert.deepEqual([r.pass, r.total], [1, 1]);
  assert.deepEqual(r.perConv, [{ id: "a", pass: 1, total: 1, min: 1, max: 1 }]);
  assert.deepEqual(r.perNode, [{ node: "fd", pass: 1, total: 1, min: 1, max: 1 }]);
  assert.deepEqual(r.couldNotRun, [
    { convId: "a", msgIndex: 3, node: "fd", why: "Zed has no bench world" },
    { convId: "b", msgIndex: 2, node: "decide", why: "x".repeat(200) },
  ], "why is sliced to 200");
  assert.equal(r.rows.length, 3, "every row stays listed");
  assert.equal(r.rows[1].ran, false);
  assert.equal(r.rows[1].ambiguous, undefined, "a could-not-run row is never also ambiguous");
});

test("an fd row whose label's own gold reply fails is ambiguous: out of the score, listed, flagged on its row", () => {
  const rows = [
    { chat: "a", at: 1, node: "fd", right: true, ran: true, usd: 0 },
    { chat: "a", at: 3, node: "fd", right: false, ran: true, usd: 0 },
    { chat: "a", at: 3, node: "decide", right: false, ran: true, usd: 0 },
    { chat: "b", at: 0, node: "fd", right: false, ran: false, usd: 0, why: "w" },
  ];
  const gold = {
    model: "gw",
    rows: 4,
    goldFails: [
      { convId: "a", msgIndex: 3, msgId: "m4", failed: [{ kind: "must", line: "say hi", reason: "said bye" }, { kind: "must not", line: "x", reason: "" }] },
      { convId: "b", msgIndex: 0, msgId: "m1", failed: [{ kind: "must", line: "y", reason: "z" }] },
    ],
    skipped: [],
  };
  const r = resultsOf(rows, "1", gold);
  // The fd row at a/3 is ambiguous, so the decide row at a/3 (a different step) still counts. b/0 could not run.
  assert.deepEqual([r.pass, r.total], [1, 2]);
  assert.deepEqual(r.perConv, [{ id: "a", pass: 1, total: 2, min: 1, max: 1 }]);
  assert.deepEqual(r.perNode, [{ node: "fd", pass: 1, total: 1, min: 1, max: 1 }, { node: "decide", pass: 0, total: 1, min: 0, max: 0 }]);
  assert.deepEqual(r.ambiguous, [{ convId: "a", msgIndex: 3, node: "fd", why: "its label's own gold reply fails: must say hi (said bye)" }]);
  assert.deepEqual(r.couldNotRun, [{ convId: "b", msgIndex: 0, node: "fd", why: "w" }]);
  assert.equal(r.goldFails, 2, "the count of labels whose gold fails, apart from the score");
  assert.equal(r.rows.length, 4, "every row stays listed");
  assert.equal(r.rows[1].ambiguous, true);
  assert.equal(r.rows[2].ambiguous, undefined, "a non-fd row at the same message is not ambiguous");
  assert.equal(r.rows[3].ambiguous, undefined, "a could-not-run row is not ambiguous");
  assert.equal(r.rows[3].ran, false);
});

test("the results CLI reads an optional gold report; a missing gold file is no gold", () => {
  const dir = mkdtempSync(join(tmpdir(), "tex-lab-gold-"));
  writeFileSync(join(dir, "rows.json"), JSON.stringify([{ chat: "a", at: 3, node: "fd", right: false, ran: true, usd: 0 }, { chat: "a", at: 4, node: "fd", right: true, ran: true, usd: 0 }]));
  writeFileSync(join(dir, "gold.json"), JSON.stringify({ model: "gw", rows: 2, goldFails: [{ convId: "a", msgIndex: 3, msgId: "m4", failed: [{ kind: "must", line: "l", reason: "r" }] }], skipped: [] }));
  const withGold = JSON.parse(execFileSync(process.execPath, [LAB_RUN, "results", join(dir, "rows.json"), "7", join(dir, "gold.json")], { encoding: "utf8" }));
  assert.deepEqual([withGold.pass, withGold.total, withGold.goldFails, withGold.ms], [1, 1, 1, 7]);
  assert.equal(withGold.ambiguous[0].why, "its label's own gold reply fails: must l (r)");
  const noGold = JSON.parse(execFileSync(process.execPath, [LAB_RUN, "results", join(dir, "rows.json"), "7", join(dir, "absent.json")], { encoding: "utf8" }));
  assert.deepEqual([noGold.total, noGold.goldFails, noGold.ambiguous], [2, null, []], "a path that does not exist is no gold");
});

test("a missed Front door row keeps the judge's reasons and Tex's texts, so its cause can be read", () => {
  const rows = [
    { chat: "w", at: 4, node: "fd", right: false, ran: true, usd: 0, got: "must: x | Tex: On it", want: "every must and never line", misses: [{ kind: "must", line: "ask only for the return date", reason: "asked nothing" }, { kind: "must not", line: "ask about budget", reason: "" }], said: ["On it.", "(Tex reacted to their text)"] },
    { chat: "w", at: 6, node: "fd", right: true, ran: true, usd: 0, got: "every line held", want: "every must and never line", misses: [], held: [{ kind: "must", line: "answer short", reason: "one line" }], said: ["fine"] },
  ];
  const r = resultsOf(rows, "1");
  assert.equal(r.rows[0].detail, "must: ask only for the return date (asked nothing)\nnever: ask about budget\nTex: On it. / (Tex reacted to their text)");
  assert.equal(r.rows[1].detail, "held: must: answer short (one line)\nTex: fine", "a passed row can be audited: what held, why, and what Tex said");
  assert.equal(detailOf({ said: ["x".repeat(3_000)] }).detail.length, 1_500);
  assert.deepEqual(detailOf({}), {});
});

test("decideSaid names every labelled field, so a miss on why shows where it differs", () => {
  const verdict = { ok: true, act: "silent", why: "chatter", movedOn: false };
  assert.deepEqual(decideSaid({ act: "quiet", why: "thanks_or_ok", also_react: "any" }, verdict), { got: "quiet, why chatter", want: "quiet, why thanks_or_ok" });
  assert.deepEqual(decideSaid({ act: "respond" }, { ok: true, act: "answer" }), { got: "respond", want: "respond" });
  assert.deepEqual(decideSaid({ act: "respond" }, null), { got: "no verdict", want: "respond" });
});

test("run_remove sends the id and refuses none", async () => {
  const { calls, call } = tool({ run_remove: { status: "ok" } });
  assert.equal((await call("run_remove", {})).isError, true);
  assert.deepEqual(jsonOf(await call("run_remove", { id: "k1" })).removed, "k1");
  assert.deepEqual(calls, [{ action: "run_remove", args: { id: "k1" } }]);
});

test("code points a draft's runs at a pull request or branch; run passes its own code only when named", async () => {
  const { calls, call } = tool({ code: (a) => ({ status: "ok", code: a.code === "main" ? null : "#3401" }), run: { status: "ok", id: "k2" } });
  assert.equal((await call("code", { code: "#3401" })).isError, true, "a draft is named");
  assert.equal((await call("code", { draft: "vabc" })).isError, true, "the code is named");
  assert.equal(jsonOf(await call("code", { draft: "vabc", code: "3401" })).code, "#3401");
  assert.equal(jsonOf(await call("code", { draft: "vabc", code: "main" })).code, "main");
  await call("run", { draft: "vabc", code: "claude/x" });
  assert.deepEqual(calls.map((c) => c.args), [{ draft: "vabc", code: "3401" }, { draft: "vabc", code: "main" }, { draft: "vabc", kind: "dev", conv: undefined, node: undefined, models: "gw", code: "claude/x" }]);
});

test("a run reports what its handed-off jobs added: jobs, parts, advisor calls and spend, per job too (Dev2, 2026-11-18, for Finance)", () => {
  const rows = [
    { chat: "a", at: 1, node: "fd", right: true, ran: true, usd: 0.05, handoff: { jobs: 1, parts: 3, advisorCalls: 2, usd: 0.03 } },
    { chat: "a", at: 3, node: "fd", right: false, ran: true, usd: 0.04, handoff: { jobs: 1, parts: 1, advisorCalls: 1, usd: 0.01 } },
    { chat: "b", at: 2, node: "decide", right: true, ran: true, usd: 0.001 },
  ];
  assert.deepEqual(handoffOf(rows), { jobs: 2, parts: 4, advisorCalls: 3, usd: 0.04, perJobUsd: 0.02, advisorCallsPerJob: 1.5 });
  assert.deepEqual(resultsOf(rows, "1").handoff, handoffOf(rows));
  assert.deepEqual([resultsOf(rows, "1").fallbacks, resultsOf(rows, "1").valid], [0, true], "no fallback: the score is Tex's");
  const fell = resultsOf([{ chat: "c", node: "fd", right: true, fallbacks: 2 }, { chat: "c", node: "fd", right: true }], "1");
  assert.deepEqual([fell.fallbacks, fell.valid, fell.rows[0].fallbacks], [2, false, 2], "a fallback marks the run invalid");
  assert.match(fell.invalid, /fell back/);
});

test("a row's detail opens with each turn's rounds of its bound, so a miss reads against running out (Dev2, 2026-11-18)", () => {
  const rounds = [{ used: 3, of: 12 }, { used: 11, of: 12, toEnd: true }, { used: 12, of: 12, toEnd: true, exhausted: true }, { used: 10, of: 12, toEnd: true, handedOff: true }];
  assert.equal(roundsLine(rounds), "rounds: 3/12, 11/12 reached its end, 12/12 ran out, 10/12 handed off");
  assert.equal(roundsLine([[{ used: 2, of: 12 }], [{ used: 12, of: 12, exhausted: true }]]), "rounds: 2/12 | 12/12 ran out", "runs apart");
  assert.equal(roundsLine([]), null);
  assert.equal(roundsLine([{ used: "x" }]), null, "only whole counts");
  const { detail } = detailOf({ rounds, misses: [{ kind: "must", line: "do it", reason: "it didn't" }], said: ["hi"] });
  assert.equal(detail.split("\n")[0], "rounds: 3/12, 11/12 reached its end, 12/12 ran out, 10/12 handed off", "first, so a long detail never cuts it");
  assert.equal(detailOf({ rounds: [] , said: ["hi"] }).detail, "Tex: hi");
});

test("a row's steps line comes right after its rounds, before the judge's lines, and survives the cut (Lab, 2026-11-18)", () => {
  const rounds = [{ used: 2, of: 12 }];
  const steps = "tools search_mail ok | answer check: let go (only_acknowledged) | outcome: quiet (send say_nothing)";
  const { detail } = detailOf({ rounds, steps, misses: [{ kind: "must", line: "do it", reason: "it didn't" }], said: ["x".repeat(3_000)] });
  assert.deepEqual(detail.split("\n").slice(0, 3), ["rounds: 2/12", `steps: ${steps}`, "must: do it (it didn't)"]);
  assert.equal(detail.length, 1_500);
  assert.equal(detailOf({ steps: "tools none | outcome: replied" }).detail, "steps: tools none | outcome: replied", "alone it is the whole detail");
  assert.deepEqual(detailOf({ steps: "" }), {}, "an empty steps line is no line");
});

test("a row's route is its first turn's (or the router's own), with its cost, and its detail says the route after the rounds (Dev2, 2026-11-18)", () => {
  const routes = [[{ pick: "read", sure: 0.9, door: "read" }, { pick: "act", door: "fd", fellBack: "outside the read door's tools: send_email" }]];
  assert.deepEqual(routeOf({ routes }), { pick: "read", sure: 0.9, door: "read" }, "the first turn of the first run");
  assert.deepEqual(routeOf({ route: { pick: "quick", sure: 0.8 } }), { pick: "quick", sure: 0.8 }, "the router node alone");
  assert.equal(routeOf({ rounds: [] }), null, "no route, no field");
  assert.equal(routeOf({ routes: [[]] }), null);
  assert.equal(routeLine({ pick: "act", sure: 0.5, door: "fd", fellBack: "not sure" }), "route: pick act (sure 0.5), door fd, fell back: not sure");
  assert.equal(routeLine(null), null);
  const rows = resultsOf([{ chat: "c", at: 0, node: "fd", right: false, got: "x", want: "y", usd: 0.0123, routes, rounds: [{ used: 2, of: 12 }], said: ["hi"] }], "5");
  assert.deepEqual(rows.rows[0].route, { pick: "read", sure: 0.9, door: "read" });
  assert.equal(rows.rows[0].usd, 0.0123);
  assert.equal(rows.rows[0].detail, "rounds: 2/12\nroute: pick read (sure 0.9), door read\nTex: hi");
  const bare = resultsOf([{ chat: "c", at: 0, node: "fd", right: true, got: "x", want: "y" }], "5");
  assert.equal("route" in bare.rows[0], false, "a row with no route says none");
  assert.equal("usd" in bare.rows[0], false);
});

test("runs { id } says the run's route summary as byRoute, from the repo's gold (Lab = MCP parity, 2026-11-18)", async () => {
  const rows = [
    { convId: "not-in-the-repo", msgIndex: 0, node: "fd", ok: true, usd: 0.02, route: { pick: "read", door: "read" } },
    { convId: "not-in-the-repo", msgIndex: 1, node: "fd", ok: false, usd: 0.02, ran: true },
  ];
  const { call } = tool({ runs: { run: { id: "r1", kind: "dev", results: { pass: 1, total: 2, rows } } } });
  const body = jsonOf(await call("runs", { id: "r1" }));
  assert.equal(body.id, "r1");
  assert.equal(body.byRoute.any, true);
  assert.deepEqual(body.byRoute.fallback, { fellBack: 0, specialist: 1, total: 1 });
  assert.deepEqual(body.byRoute.costPerTurn, { usd: 0.04, turns: 2, perTurn: 0.02 });
  assert.equal(body.byRoute.perRoute.find((b) => b.route === "untagged").total, 2, "no repo label: all untagged");
  const queued = tool({ runs: { run: { id: "r2", stage: "queued" } } });
  assert.equal(jsonOf(await queued.call("runs", { id: "r2" })).byRoute, undefined, "a run with no results says no route summary");
});

// gw Lab runs, 2026-11-18: every Claude call failed for lack of credit, yet 69 of 101 rows were stored and the run read
// valid. Sabotage: make `brokenRun` return null, and this fails.
test("a run whose Claude calls ran out of credit, or most of one step's tests could not run, is invalid with why", () => {
  const credit = "could not run: judge failed: judge call for question 1 failed: status 400 (Your credit balance is too low…)";
  const rows = [
    { chat: "a", node: "fd", ran: true, right: true },
    { chat: "b", node: "fd", ran: true, right: false },
    { chat: "c", node: "fd", ran: false, right: false, why: credit },
  ];
  const out = resultsOf(rows, 10);
  assert.equal(out.valid, false);
  assert.match(out.invalid, /credit balance is too low/);
  assert.doesNotMatch(out.invalid, /sk-|Bearer/);
  assert.match(out.couldNotRun[0].why, /credit balance/);
  const most = [{ node: "decide", ran: true, right: true }, { node: "decide", ran: false, why: "x broke" }, { node: "decide", ran: false, why: "y" }, { node: "fd", ran: true, right: true }];
  assert.equal(brokenRun(most), "2 of decide's 3 tests could not run: x broke");
  assert.equal(resultsOf(most, 1).valid, false);
  const half = [{ node: "decide", ran: true, right: true }, { node: "decide", ran: false, why: "a picture" }];
  assert.equal(brokenRun(half), null, "half is not more than half");
  assert.equal(resultsOf(half, 1).valid, true);
  // The workflow's ran step fails an out-of-credit run, the reason kept for the Lab and the public log counts only.
  const dir = mkdtempSync(join(tmpdir(), "tex-lab-run-"));
  const why = join(dir, "why");
  writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
  const ran = spawnSync(process.execPath, [LAB_RUN, "ran", join(dir, "rows.json")], { encoding: "utf8", env: { ...process.env, TEX_LAB_WHY: why } });
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /ran out of credit: 1 of 3 tests could not run/);
  assert.doesNotMatch(ran.stderr, /question 1/);
  assert.match(readFileSync(why, "utf8"), /credit balance is too low/);
});

test("repeated rows collapse to one row a unit test: the mean, its band, the majority verdict, every repeat's spend, and couldNotRun only when no repeat ran (Dev2, 2026-11-19)", () => {
  const rows = [
    { chat: "r", at: 1, node: "fd", rep: 0, right: true, ran: true, usd: 0.01, got: "ok", want: "w" },
    { chat: "r", at: 1, node: "fd", rep: 1, right: false, ran: true, usd: 0.01, got: "late", want: "w", misses: [{ kind: "must", line: "say hi", reason: "no" }] },
    { chat: "r", at: 1, node: "fd", rep: 2, right: true, ran: true, usd: 0.01, got: "ok", want: "w" },
    { chat: "r", at: 4, node: "fd", rep: 0, right: false, ran: false, usd: 0, why: "no draft" },
    { chat: "r", at: 4, node: "fd", rep: 1, right: false, ran: false, usd: 0, why: "no draft" },
    { chat: "r", at: 4, node: "fd", rep: 2, right: false, ran: false, usd: 0, why: "no draft" },
    { chat: "s", at: 0, node: "fd", rep: 0, right: false, ran: true, usd: 0.02, got: "x", want: "y" },
    { chat: "s", at: 0, node: "fd", rep: 1, right: true, ran: true, usd: 0.02, got: "y", want: "y" },
    { chat: "s", at: 0, node: "fd", rep: 2, right: true, ran: true, usd: 0.02, got: "y", want: "y" },
  ];
  const r = resultsOf(rows, "1");
  // Per repeat: r is right at 0 and 2, s at 1 and 2: [1, 1, 2], so the mean 1.33 over two tests, band 1 to 2.
  assert.deepEqual([r.pass, r.total, r.repeats], [1.33, 2, 3]);
  assert.deepEqual(r.score, { mean: 1.33, min: 1, max: 2, lo: r.score.lo, hi: r.score.hi, repeats: 3, total: 2 });
  assert.deepEqual(r.couldNotRun, [{ convId: "r", msgIndex: 4, node: "fd", why: "no draft" }], "one entry for the test none of whose repeats ran");
  assert.equal(r.rows.length, 3, "one row a test");
  assert.deepEqual(r.rows[0], {
    convId: "r", msgIndex: 1, node: "fd", ok: true, got: "passed 2/3; late", want: "w", runs: 3, passes: 2,
    detail: "must: say hi (no)", usd: 0.03, tags: [],
  });
  assert.deepEqual(r.rows[1], { convId: "r", msgIndex: 4, node: "fd", ok: false, got: "can't run: no draft", want: "", ran: false, usd: 0 });
  assert.deepEqual(r.rows[2], { convId: "s", msgIndex: 0, node: "fd", ok: true, got: "passed 2/3; x", want: "y", runs: 3, passes: 2, usd: 0.06, tags: [] });
  assert.equal(r.costUsd, 0.09, "costUsd is every raw row's spend: each repeat is real");
  assert.deepEqual(r.perNode, [{ node: "fd", pass: 1.33, total: 2, min: 1, max: 2 }]);
  assert.deepEqual(r.perConv, [
    { id: "r", pass: 0.67, total: 1, min: 0, max: 1 },
    { id: "s", pass: 0.67, total: 1, min: 0, max: 1 },
  ]);
});

test("a single repeat reads as before: the integer pass, one repeat in the band, and the fidelity label only for Claude Code runs", () => {
  const rows = [{ chat: "c", at: 0, node: "decide", right: true, ran: true, usd: 0.0004 }];
  const r = resultsOf(rows, "1");
  assert.equal(r.pass, 1);
  assert.equal(r.repeats, 1);
  assert.deepEqual(r.score, { mean: 1, min: 1, max: 1, lo: 1, hi: 1, repeats: 1, total: 1 });
  assert.equal("fidelity" in r, false, "no models named: no fidelity label");
  const gw = resultsOf(rows, "1", null, { models: "gw" });
  assert.equal("fidelity" in gw, false, "a gateway run is not labelled");
  const cc = resultsOf(rows, "1", null, { models: "cc" });
  assert.deepEqual([cc.fidelity, cc.fidelityWhy], [CC_FIDELITY, CC_FIDELITY_WHY]);
  assert.equal(cc.fidelity, "model family only");
});

test("resultsOf and scoreByRepeat agree on a repeated test: its pass is the mean of its repeats", () => {
  const rows = [
    { chat: "a", at: 1, node: "fd", rep: 0, right: true, ran: true },
    { chat: "a", at: 1, node: "fd", rep: 1, right: true, ran: true },
    { chat: "a", at: 1, node: "fd", rep: 2, right: false, ran: true },
  ];
  assert.equal(resultsOf(rows, "1").pass, scoreByRepeat(rows).score.mean);
  assert.equal(resultsOf(rows, "1").pass, 0.67);
});

test("a repeated Front door run's rows still mark it unrun only when no repeat of a step ran", () => {
  const rows = [0, 1, 2].map((rep) => ({ chat: "u", at: 0, node: "fd", rep, right: false, ran: false, usd: 0, why: "no bench world" }));
  assert.deepEqual(unrun(rows), [{ node: "fd", total: 3, why: "no bench world" }]);
  assert.deepEqual(unrun(rows.map((r, i) => (i === 1 ? { ...r, ran: true } : r))), []);
});

test("a Dev gold report: an fd row whose label's own gold fails could not run, with no label line or reason", () => {
  const rows = [
    { chat: "a", at: 1, node: "fd", right: true, ran: true, usd: 0 },
    { chat: "a", at: 3, node: "fd", right: false, ran: true, usd: 0 },
    { chat: "a", at: 3, node: "decide", right: false, ran: true, usd: 0 },
  ];
  const gold = { model: "gw", set: "dev", rows: 2, goldFails: [{ convId: "a", msgIndex: 3, msgId: "m4", failed: [{ kind: "must" }] }], impossible: [], skipped: [] };
  const r = resultsOf(rows, "1", gold);
  assert.deepEqual([r.pass, r.total], [1, 2], "the failed Dev fd row is out of the score");
  assert.deepEqual(r.ambiguous, [], "a Dev row is not ambiguous");
  assert.deepEqual(r.couldNotRun, [{ convId: "a", msgIndex: 3, node: "fd", why: "its label's own gold reply fails (gold self-check)" }]);
  assert.equal(r.rows[1].ran, false);
  assert.equal(r.rows[1].got, "can't run: its label's own gold reply fails (gold self-check)");
  assert.equal(r.rows[2].ran, undefined, "a non-fd row at the same message still counts");
  assert.equal(r.goldFails, 1);
  assert.equal(r.impossible, 0);
  assert.doesNotMatch(JSON.stringify(r), /must say|said/, "no label line or reason reaches the results");
});

test("an impossible fd row could not run in training and in dev, with why: its first must line's missing ability", () => {
  const rows = [
    { chat: "a", at: 0, node: "fd", right: false, ran: true, usd: 0 },
    { chat: "a", at: 2, node: "fd", right: true, ran: true, usd: 0 },
    { chat: "b", at: 0, node: "fd", right: false, ran: true, usd: 0 },
  ];
  const impossible = [{ convId: "a", msgIndex: 0, msgId: "m1", lines: [{ line: "find the phone's contacts", missing: "the phone's address book" }] }];
  const training = resultsOf(rows, "1", { model: "gw", set: "training", rows: 3, goldFails: [], impossible, skipped: [] });
  const dev = resultsOf(rows, "1", { model: "gw", set: "dev", rows: 3, goldFails: [], impossible, skipped: [] });
  for (const r of [training, dev]) {
    assert.deepEqual([r.pass, r.total], [1, 2], "the impossible row is out of pass and total");
    assert.deepEqual(r.couldNotRun, [{ convId: "a", msgIndex: 0, node: "fd", why: "can't pass honestly: needs the phone's address book" }]);
    assert.deepEqual(r.perConv, [{ id: "a", pass: 1, total: 1, min: 1, max: 1 }, { id: "b", pass: 0, total: 1, min: 0, max: 0 }]);
    assert.equal(r.rows[0].ran, false);
    assert.equal(r.rows[0].got, "can't run: can't pass honestly: needs the phone's address book");
    assert.equal(r.rows[0].ambiguous, undefined);
    assert.equal(r.rows[1].ran, undefined);
    assert.equal(r.impossible, 1);
  }
});

test("training is unchanged: a failed fd row is ambiguous, not could-not-run, and a gold without a set is training", () => {
  const rows = [
    { chat: "a", at: 3, node: "fd", right: false, ran: true, usd: 0 },
    { chat: "a", at: 4, node: "fd", right: true, ran: true, usd: 0 },
  ];
  const goldFails = [{ convId: "a", msgIndex: 3, msgId: "m4", failed: [{ kind: "must", line: "say hi", reason: "said bye" }] }];
  for (const gold of [{ model: "gw", set: "training", rows: 2, goldFails, skipped: [] }, { model: "gw", rows: 2, goldFails, skipped: [] }]) {
    const r = resultsOf(rows, "1", gold);
    assert.deepEqual([r.pass, r.total, r.couldNotRun], [1, 1, []]);
    assert.deepEqual(r.ambiguous, [{ convId: "a", msgIndex: 3, node: "fd", why: "its label's own gold reply fails: must say hi (said bye)" }]);
    assert.equal(r.rows[0].ambiguous, true);
    assert.equal(r.rows[0].ran, undefined);
    assert.equal(r.goldFails, 1);
    assert.equal(r.impossible, 0);
  }
  assert.equal(resultsOf(rows, "1").impossible, null, "no gold report, no impossible count");
});

// The world a run had (the bench world's record and replay): the misses of each row, deduped, by kind, the first 40;
// null when no row has a world, so the Lab says nothing rather than "replayed from fixtures".
test("resultsOf carries the run world: its misses by kind and their calls, none when no row has a world", () => {
  const call = (kind, text) => ({ kind, call: text });
  const rows = [
    { chat: "a", at: 0, node: "fd", right: true, ran: true, world: { misses: 2, calls: [call("web search", '{"query":"x"}'), call("gmail search", "{}")] } },
    { chat: "a", at: 1, node: "fd", right: false, ran: true, got: "y", want: "z", world: { misses: 2, calls: [call("web search", '{"query":"x"}'), call("gmail search", "{}")] } },
    { chat: "b", at: 0, node: "fd", right: true, ran: true, world: { misses: 0, calls: [] } },
    { chat: "a", at: 0, node: "decide", right: true, ran: true },
  ];
  const r = resultsOf(rows, "5");
  assert.deepEqual(r.world, {
    misses: 2,
    byKind: { "web search": 1, "gmail search": 1 },
    calls: [{ chat: "a", kind: "web search", call: '{"query":"x"}' }, { chat: "a", kind: "gmail search", call: "{}" }],
  });
  assert.deepEqual(worldOf(rows), r.world);
  const many = Array.from({ length: 50 }, (_, k) => ({ chat: "m", at: k, node: "fd", right: true, ran: true, world: { misses: 1, calls: [call("web search", "q" + k)] } }));
  assert.equal(worldOf(many).misses, 50);
  assert.equal(worldOf(many).calls.length, 40, "the first 40 calls only");
  assert.equal(resultsOf([{ chat: "a", node: "decide", right: true, ran: true }], "1").world, null, "no row has a world: nothing to say");
});
