/**
 * The call budget of a simple texted turn, before its model runs.
 *
 * A "hi" from a person, on the warm copy the last answer handed back, may make
 * at most `WARM_BUDGET` storage and control-plane calls before the model is
 * called. Each one is 130-220 ms in production, and the calls a turn makes
 * before its model are the ones the person waits for. A change that adds one
 * (a read the copy could have answered, a write that could wait for the answer)
 * fails here, and says which calls it made.
 *
 * The count is taken on the fixture world (`agentEgressFixtures.mjs`), where the
 * copy, the chat and the notes are small. The budget is about what the turn
 * asks for, not how big the bucket is: a production turn makes the same calls
 * on a larger one, and more of them when the copy is missing (the cold turn,
 * which is not budgeted here).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

/**
 * Storage and control-plane calls before the model, on a warm simple text:
 * session, binding, the built-in model's check, the plugin switches, the prior
 * turn's record, the running mark (its read and its write), and the Google offer's
 * mail check. Two of them are the auth the Worker makes for every request.
 */
const WARM_BUDGET = 8;

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

/** One texted turn through `/agent`, and the storage and control-plane calls it made before its model was called. */
async function turnCalls(world, { question, turn, warm, recent, covers }) {
  const calls = [];
  let modelCalled = false;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host.startsWith("gateway.ai")) {
      modelCalled = true;
      return inner(input, init);
    }
    if (!modelCalled) {
      const method = init.method ?? (typeof input !== "string" && input.method) ?? "GET";
      calls.push(`${url.host.split(".")[0]} ${method} ${url.pathname}`);
    }
    return inner(input, init);
  };
  try {
    const answered = await request(world.env, TOKEN_TEXTS, "/agent", {
      question,
      conversation: "texts",
      covers,
      chat: CHAT,
      recent,
      turn,
      ...(warm ? { warm } : {}),
    });
    assert.equal(answered.status, 200, `the turn answered ${answered.status}: ${JSON.stringify(answered.body)}`);
    return { calls, warm: answered.body.warm };
  } finally {
    globalThis.fetch = inner;
  }
}

test("a warm simple texted turn makes at most the budgeted calls before its model", async () => {
  const world = await createEgressWorld();
  try {
    let warm;
    const recent = [];
    // Turn one has no copy and reads everything; turn two is the warm one measured.
    for (const [i, measured] of [[1, false], [2, true]]) {
      const e = event(Date.now(), { text: `question ${i}` });
      recent.push(e);
      world.model.install([{ text: `Answer ${i}` }]);
      const turn = `turn-budget-${String(i).padStart(4, "0")}`;
      const result = await turnCalls(world, {
        question: `question ${i}`,
        turn,
        warm,
        recent: recent.slice(-20),
        covers: [e.id],
      });
      warm = result.warm;
      recent.push(event(Date.now(), { from: { kind: "tex" }, text: `Answer ${i}`, turn, covers: [e.id] }));
      if (measured) {
        assert.ok(
          result.calls.length <= WARM_BUDGET,
          `a warm simple text made ${result.calls.length} storage and control-plane calls before its model (budget ${WARM_BUDGET}):\n  ${result.calls.join("\n  ")}`,
        );
      }
    }
  } finally {
    world.restore();
  }
});
