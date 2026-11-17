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
import { execFileSync } from "node:child_process";
import { detailOf, devConversations, resultsOf, sanitizeResults } from "../../../scripts/tex-lab-run.mjs";
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

test("results count by chat and by step, with each test's verdict and no words", () => {
  const rows = [
    { chat: "g", msg: "m3", at: 2, node: "decide", right: true, ran: true, usd: 0.0004, got: "respond", want: "respond" },
    { chat: "g", msg: "m9", at: 8, node: "decide", right: false, ran: true, usd: 0.0004, got: "quiet", want: "respond", why: "act quiet, wanted respond" },
    { chat: "m", msg: "m2", at: 1, node: "fd", right: false, ran: false, usd: 0, why: "runs alone only on a one-ask chat" },
  ];
  const r = resultsOf(rows, "1200");
  assert.deepEqual([r.pass, r.total, r.costUsd, r.ms], [1, 3, 0.0008, 1200]);
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

test("a lone surrogate in a reply is stored as a replacement character, which jq can read", () => {
  // PR 3548's Dev run (2026-11-17): a reply kept U+D83D, the lead half of an emoji, and jq
  // refused the results file, so the report step never stored the run.
  const rows = [{ chat: "w", at: 1, node: "fd", right: true, usd: 0, got: "July 10? \uD83D", want: "ok \uDFFF", said: ["July 10? \uD83D\uDCC5 and \uD83D"] }];
  const text = JSON.stringify(resultsOf(rows, "1"));
  assert.doesNotMatch(text, /\\ud83d|\\udfff/i);
  assert.match(text, /July 10\? \uFFFD/);
  assert.match(text, /\uD83D\uDCC5/, "a complete emoji pair is kept");
  const fixed = sanitizeResults(JSON.stringify({ got: "July 10? \uD83D" }));
  assert.doesNotMatch(fixed, /\\ud83d/i);
  assert.equal(execFileSync("jq", ["-c", "{pass,total}"], { input: text, encoding: "utf8" }).trim(), '{"pass":1,"total":1}');
  assert.equal(execFileSync("jq", ["-r", ".got"], { input: fixed, encoding: "utf8" }).trim(), "July 10? \uFFFD");
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
