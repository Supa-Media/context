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
import { detailOf, devConversations, handoffOf, resultsOf, roundsLine, trainingConversations, uncast, unrun } from "../../../scripts/tex-lab-run.mjs";
import { decideSaid } from "../bench/setsRun.mjs";

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
  assert.deepEqual(jsonOf(await call("runs", { id: "k1" })), { id: "k1", stage: "done", results: { rows: [] } });
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
  assert.deepEqual([r.pass, r.total, r.costUsd, r.ms], [1, 3, 0.0008, 1200]);
  assert.deepEqual(r.handoff, { jobs: 0, parts: 0, advisorCalls: 0, usd: 0, perJobUsd: 0, advisorCallsPerJob: 0 }, "no hand-off, all zero");
  assert.deepEqual(r.perConv, [{ id: "g", pass: 1, total: 2 }, { id: "m", pass: 0, total: 1 }]);
  assert.deepEqual(r.perNode, [{ node: "decide", pass: 1, total: 2 }, { node: "fd", pass: 0, total: 1 }]);
  assert.deepEqual(r.rows[1], { convId: "g", msgIndex: 8, node: "decide", ok: false, got: "quiet", want: "respond" });
  assert.deepEqual(r.rows[2], { convId: "m", msgIndex: 1, node: "fd", ok: false, got: "can't run: runs alone only on a one-ask chat", want: "", ran: false }, "a test that did not run says why");
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
