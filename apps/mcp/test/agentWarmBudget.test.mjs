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
import { createEgressWorld, keepDeskKeys, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

/**
 * Storage and control-plane calls before the model, on a warm simple text:
 * session, binding, the waiting asks, the built-in model's check, the plugin
 * switches, and the Google offer's mail check. Two of them are the auth the
 * Worker makes for every request. The history, the turn records and the
 * running mark are the person's Tex object's (`OBJECT_BUDGET`), and so are
 * About me and the jobs list (2026-11-01).
 *
 * The waiting asks are listed on every texted turn and cannot come off this
 * budget: a job, a routine or the heartbeat arms one beside the chat without
 * writing the copy, so a copy that said none waited can be older than the ask,
 * and that listing and the disarm it feeds are the whole protection between
 * such an ask and a bare "yes" (`agentFrontDoor.test.mjs`).
 */
const WARM_BUDGET = 7;

/**
 * Calls to the person's own Tex object before the model (`texStore/desk.js`):
 * the desk (history, About me and the jobs list in one), and the running
 * mark's read and write. The prior turn's record is the copy's. Each is a call
 * to an object in the gateway's region, not a bucket read; still budgeted, so
 * a read that creeps back in one record at a time fails here.
 */
const OBJECT_BUDGET = 3;

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

/** How many of the object calls since `from` came before the model. */
function modelObjectCallsAt(world, from) {
  return (world.tex.modelAt ?? world.tex.calls.length) - from;
}

/** One texted turn through `/agent`, and the storage and control-plane calls it made before its model was called. */
async function turnCalls(world, { question, turn, warm, recent, covers }) {
  const calls = [];
  let modelCalled = false;
  const objectCalls = world.tex.calls.length;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host.startsWith("gateway.ai")) {
      if (!modelCalled) world.tex.modelAt = world.tex.calls.length;
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
    return { calls, warm: answered.body.warm, objectCalls: world.tex.calls.slice(objectCalls, objectCalls + modelObjectCallsAt(world, objectCalls)) };
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
      world.tex.modelAt = undefined;
      // The workspace has no About me or jobs list: as the lookup behind the reply keeps it in a keyed workspace (`texDesk.js`).
      if (i === 1) await keepDeskKeys(world, { about: false, jobs: false });
      recent.push(event(Date.now(), { from: { kind: "tex" }, text: `Answer ${i}`, turn, covers: [e.id] }));
      if (measured) {
        const person = result.objectCalls.filter((call) => call.name === "person:ws_egress");
        assert.ok(person.length <= OBJECT_BUDGET, `a warm simple text made ${person.length} calls to the person's object before its model (budget ${OBJECT_BUDGET}): ${person.map((call) => call.op).join(", ")}`);
        assert.equal(person.filter((call) => call.op === "desk").length, 1, "the history, About me and the jobs list come in one desk call");
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

