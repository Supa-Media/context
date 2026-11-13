/*
 * `run_model` (`manage` action `run_model`): a Workers AI model run for the
 * Architecture Lab, by a person who edits `@context-lc`'s AI setup, with the
 * gateway's own AI binding. Read `src/tools/runModel.js` for why it exists.
 *
 * Every refusal is proven by a test that fails if the refusal is removed: see
 * the sabotage record below.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary edits to `src/tools/runModel.js` and reverted (the file
 * was compared byte for byte afterwards).
 *
 *   role check removed (`editsPinnedContext` not consulted)
 *     → "who: a member, a session with no @context-lc and a self-hosted deployment are refused"
 *       and "the log line says ok false for a failed run, and a refusal logs nothing" fail
 *       (the refusal still held in the dispatch gate and the advertised list, which are separate checks)
 *   the allowlist check removed
 *     → "what: a model outside LAB_MODELS is refused, a different @cf model and a URL-ish string alike" fails
 *   the size check removed
 *     → "size: an input over 64,000 characters of JSON is refused, exactly 64,000 is not" fails
 *   the model's exception rethrown instead of answered as isError
 *     → "an exception from the model is an isError answer with its message, never a throw" and
 *       "the log line says ok false for a failed run, and a refusal logs nothing" fail
 *   the input added to the log line
 *     → "the log line is the fixed shape and carries no input or output" fails
 *
 * With the role check restored: 15 of 15 pass.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runLabModel, LAB_MODELS, MAX_INPUT_CHARS, toolRunModel } from "../src/tools/runModel.js";
import { editsPinnedContext } from "../src/context/identity.js";
import { toolDefinitions, STAFF_ONLY_TOOLS } from "../src/tools/registry.js";
import { textingWriteTools, WITHHELD_TOOLS } from "../src/agent/textingWrites.js";
import { agentTools } from "../src/agent/turn.js";
import { toolsForSession } from "../src/tools/advertised.js";
import { callToolForSession } from "../src/tools/session.js";


const WHO = "run_model is for people who edit @context-lc's AI setup.";
const NO_BINDING = "Workers AI is not set up on this deployment.";

function session(role, { pinned = true, workspaceId = "ws_mine" } = {}) {
  const workspaces = [{ workspaceId: "ws_mine", slug: "mine", role: "owner", kind: "personal" }];
  if (pinned) workspaces.push({ workspaceId: "ws_pin", slug: "context-lc", role, kind: "shared" });
  return {
    workspaceId,
    workspaces,
    scopes: ["context:read", "context:write", "context:private"],
    grantScopes: ["context:read", "context:write", "context:private"],
    actorUserId: "user_test",
  };
}

/** A binding that answers `answer` and records every call it was given. */
function fakeAI(answer = { response: "ok" }) {
  const calls = [];
  return {
    calls,
    async run(model, input, ...rest) {
      calls.push({ model, input, rest });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** Capture the one line a run logs. */
async function logged(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

const OK_ARGS = { model: "@cf/cloudflare/clef", input: { state: "a page", questions: ["yes or no?"] } };

test("editsPinnedContext: only an owner or an editor of @context-lc", () => {
  assert.equal(editsPinnedContext(session("owner")), true);
  assert.equal(editsPinnedContext(session("editor")), true);
  assert.equal(editsPinnedContext(session("member")), false);
  assert.equal(editsPinnedContext(session("owner", { pinned: false })), false);
  assert.equal(editsPinnedContext({ workspaces: [] }), false);
  assert.equal(editsPinnedContext({}), false);
});

test("who: a member, a session with no @context-lc and a self-hosted deployment are refused", async () => {
  for (const who of [session("member"), session("owner", { pinned: false }), { workspaces: undefined }]) {
    const ai = fakeAI();
    const answer = await runLabModel({ ai, session: who, workspace: "ws_mine", args: OK_ARGS });
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, WHO);
    assert.equal(ai.calls.length, 0, "the model must not be called");
  }
});

test("who: an owner and an editor of @context-lc run a model", async () => {
  for (const role of ["owner", "editor"]) {
    const ai = fakeAI({ response: "yes" });
    const answer = await runLabModel({ ai, session: session(role), workspace: "ws_pin", args: OK_ARGS });
    assert.equal(answer.isError, undefined);
    assert.equal(ai.calls.length, 1, role);
  }
});

test("what: a model outside LAB_MODELS is refused, a different @cf model and a URL-ish string alike", async () => {
  assert.deepEqual(LAB_MODELS, ["@cf/cloudflare/clef", "@cf/zai-org/glm-4.7-flash"]);
  for (const model of [
    "@cf/meta/llama-3.1-8b-instruct",
    "https://evil.example/run",
    "@cf/cloudflare/clef ",
    "@cf/cloudflare/clef/../other",
    "anthropic/claude-haiku-5-5",
    "",
    undefined,
    7,
  ]) {
    const ai = fakeAI();
    const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: { model, input: { a: 1 } } });
    assert.equal(answer.isError, true, JSON.stringify(model));
    assert.equal(ai.calls.length, 0, JSON.stringify(model));
  }
});

test("what: both allowlisted models run", async () => {
  for (const model of LAB_MODELS) {
    const ai = fakeAI({ ok: true });
    const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: { model, input: { a: 1 } } });
    assert.equal(answer.isError, undefined, model);
    assert.equal(ai.calls[0].model, model);
  }
});

test("size: input must be a plain object", async () => {
  for (const input of ["a string", ["an", "array"], null, 12, undefined]) {
    const ai = fakeAI();
    const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: { model: LAB_MODELS[0], input } });
    assert.equal(answer.isError, true, JSON.stringify(input));
    assert.equal(ai.calls.length, 0, JSON.stringify(input));
  }
});

test("size: an input over 64,000 characters of JSON is refused, exactly 64,000 is not", async () => {
  assert.equal(MAX_INPUT_CHARS, 64_000);
  const atLimit = { text: "x".repeat(MAX_INPUT_CHARS - '{"text":""}'.length) };
  assert.equal(JSON.stringify(atLimit).length, MAX_INPUT_CHARS);
  const ok = fakeAI();
  assert.equal((await runLabModel({ ai: ok, session: session("owner"), workspace: "ws_pin", args: { model: LAB_MODELS[0], input: atLimit } })).isError, undefined);
  const over = { text: "x".repeat(MAX_INPUT_CHARS - '{"text":""}'.length + 1) };
  const ai = fakeAI();
  const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: { model: LAB_MODELS[0], input: over } });
  assert.equal(answer.isError, true);
  assert.equal(ai.calls.length, 0);
});

test("the binding: with no Workers AI binding the run is refused by name", async () => {
  for (const ai of [undefined, null, {}]) {
    const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: OK_ARGS });
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, NO_BINDING);
  }
});

test("the run: the binding gets the model and the input, and the answer is its raw output as JSON text", async () => {
  const ai = fakeAI({ response: "yes", score: 0.9 });
  const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: OK_ARGS });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, "@cf/cloudflare/clef");
  assert.deepEqual(ai.calls[0].input, OK_ARGS.input);
  assert.deepEqual(ai.calls[0].rest, [], "no gateway options: the product's Workers AI calls for these models pass none");
  assert.equal(answer.content[0].text, JSON.stringify({ response: "yes", score: 0.9 }));
});

test("an exception from the model is an isError answer with its message, never a throw", async () => {
  const ai = fakeAI(new Error("model says no"));
  const answer = await runLabModel({ ai, session: session("owner"), workspace: "ws_pin", args: OK_ARGS });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /model says no/);
});

test("the log line is the fixed shape and carries no input or output", async () => {
  const secretInput = { state: "PRIVATE-INPUT-MARKER", questions: ["q"] };
  const { result, lines } = await logged(() =>
    runLabModel({ ai: fakeAI({ answer: "PRIVATE-OUTPUT-MARKER" }), session: session("owner"), workspace: "ws_pin", args: { model: LAB_MODELS[1], input: secretInput } }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /PRIVATE-INPUT-MARKER|PRIVATE-OUTPUT-MARKER/);
  const line = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(line).sort(), ["event", "model", "ms", "ok", "workspace"]);
  assert.equal(line.event, "lab_model_run");
  assert.equal(line.model, LAB_MODELS[1]);
  assert.equal(line.workspace, "ws_pin");
  assert.equal(line.ok, true);
  assert.equal(typeof line.ms, "number");
});

test("the log line says ok false for a failed run, and a refusal logs nothing", async () => {
  const failed = await logged(() =>
    runLabModel({ ai: fakeAI(new Error("boom")), session: session("owner"), workspace: "ws_pin", args: OK_ARGS }),
  );
  assert.equal(JSON.parse(failed.lines[0]).ok, false);
  const refused = await logged(() => runLabModel({ ai: fakeAI(), session: session("member"), workspace: "ws_mine", args: OK_ARGS }));
  assert.equal(refused.lines.length, 0);
});

test("the tool is never offered to Tex: not in a text, a group, or an agent turn", () => {
  const all = toolDefinitions();
  assert.ok(all.some((tool) => tool.name === "run_model"), "the tool is registered");
  assert.equal(WITHHELD_TOOLS.has("run_model"), true);
  assert.ok(!textingWriteTools(all, { texting: true }).some((tool) => tool.name === "run_model"));
  assert.ok(!textingWriteTools(all, { texting: false }).some((tool) => tool.name === "run_model"));
  assert.ok(!agentTools(all).some((tool) => tool.name === "run_model"));
});

test("the tool is offered to an editor's or owner's connection, and not to a member's", async () => {
  const store = { async get() { return null; } };
  for (const role of ["owner", "editor"]) {
    const names = (await toolsForSession(session(role), store, { shape: "v1" })).map((tool) => tool.name);
    assert.ok(names.includes("run_model"), role);
  }
  const names = (await toolsForSession(session("member"), store, { shape: "v1" })).map((tool) => tool.name);
  assert.ok(!names.includes("run_model"));
  assert.ok(STAFF_ONLY_TOOLS.has("run_model"));
});

test("a call from a member is refused before it reaches the store, and a store with no run attached refuses too", async () => {
  const reached = [];
  const store = {
    runLabModel: async (args) => {
      reached.push(args);
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  const refused = await callToolForSession({ name: "run_model", arguments: OK_ARGS }, store, session("member"));
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, WHO);
  assert.equal(reached.length, 0);
  // A store with no run attached (no pinned-workspace session) is refused with the same sentence.
  assert.equal((await toolRunModel({}, OK_ARGS)).isError, true);
});
