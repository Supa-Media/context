/**
 * `tex_dev` `evals`, `eval_run` and `eval_remove` (`packages/lab/gateway/texDev/tool.js`; Dev2, 2026-11-20: the Lab's Evals tab as MCP
 * actions, Lab = MCP parity): what each sends the control plane and answers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { texDevToolDefinitions } from "../src/tools/schemas/texDev.js";

const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const tool = (answers) => {
  const calls = [];
  const controlPlane = { async texDev(_token, action, args) { calls.push({ action, args }); const a = answers[action]; return typeof a === "function" ? a(args) : (a ?? null); } };
  return { calls, call: createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session: { accessToken: "tok" }, controlPlane }) };
};

test("the guide, the schema's description and its action list name the eval actions", () => {
  const def = texDevToolDefinitions()[0];
  for (const action of ["evals", "eval_run", "eval_remove"]) {
    assert.match(guideText(), new RegExp(`- ${action} `));
    assert.match(def.description, new RegExp(`\\b${action}\\b`));
    assert.match(def.inputSchema.properties.action.description, new RegExp(`\\b${action}\\b`));
  }
});

test("eval_run sends the bench, slice, models (gw by default) and code; a refusal is said", async () => {
  const { calls, call } = tool({ eval_run: (a) => (a.n === 999 ? { status: "bad_request", error: "n is 1 to 500 questions" } : { status: "ok", id: "e1" }) });
  assert.equal(jsonOf(await call("eval_run", {})).run, "e1");
  assert.deepEqual(calls[0], { action: "eval_run", args: { bench: undefined, n: undefined, models: "gw" } });
  await call("eval_run", { bench: "longmemeval-oracle", n: 10, models: "cc", code: "#3401" });
  assert.deepEqual(calls[1].args, { bench: "longmemeval-oracle", n: 10, models: "cc", code: "#3401" });
  const refused = await call("eval_run", { n: 999 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /1 to 500/);
});

test("evals lists benchmarks and runs; evals { id } is one run whole; eval_remove needs an id", async () => {
  const { calls, call } = tool({
    evals: (a) => (a.id ? { status: "ok", run: { id: a.id, stage: "done", questions: [{ id: "q1", correct: true }] } } : { status: "ok", benches: [{ id: "longmemeval-s" }], runs: [{ id: "e1" }] }),
    eval_remove: { status: "ok" },
  });
  assert.deepEqual(jsonOf(await call("evals", {})), { benches: [{ id: "longmemeval-s" }], runs: [{ id: "e1" }] });
  assert.deepEqual(jsonOf(await call("evals", { id: "e1" })), { id: "e1", stage: "done", questions: [{ id: "q1", correct: true }] });
  assert.equal((await call("eval_remove", {})).isError, true);
  assert.equal(jsonOf(await call("eval_remove", { id: "e1" })).removed, "e1");
  assert.deepEqual(calls.map((c) => c.action), ["evals", "evals", "eval_remove"]);
});
