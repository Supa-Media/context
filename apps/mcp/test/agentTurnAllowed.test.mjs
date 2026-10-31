/**
 * THE CONTROL PLANE'S YES, ASKED BESIDE THE MODEL (`src/agent/turnAllowed.js`).
 *
 * 2026-10-31: `/gateway/builtin-model` took 9.7 s of a text whose model took
 * 3 s, because every turn waited for it before reading anything. It is now
 * asked when the turn starts and raced against the first model round. What
 * must hold: a yes that comes late holds the round's tool calls until it
 * comes; a no that comes late ends the turn with nothing run, kept or metered;
 * a no that is already known spends no model call.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `besideAllowed(allowed, …)` replaced by the bare request in `runTurn`:
 *    "a late yes holds the round's tools" and "a late no runs nothing" fail
 *    (the note is written before the answer is known);
 *  - `refusedYet()` dropped before the model call: "a no already known spends
 *    no model call" fails;
 *  - `isRefusal(…)` return dropped from `route.js`'s catch: "a late no" fails
 *    (the refusal is thrown as a 500 and the failed turn is metered).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedBeside, besideAllowed, isRefusal } from "../src/agent/turnAllowed.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const BUILTIN_ALLOWED = { allowed: true, remaining: 100 };
const DAILY_CAP = { allowed: false, reason: "daily_cap" };

/** A verdict the test answers when it chooses. */
function lateVerdict() {
  let answer;
  const verdict = new Promise((resolve) => (answer = resolve));
  return { verdict, answer };
}

/** Wait, a turn of the event loop at a time, until `ready()` is true. */
async function until(ready, what) {
  for (let i = 0; i < 500; i += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`never happened: ${what}`);
}

/** The note the round asks to write, wherever the bucket keeps it. */
const written = (world) => world.objectsUnder("").filter((key) => String(world.bucket.get(key)?.body ?? "").includes("# Allowed")).length;

const WRITE = { toolCalls: [{ name: "write_note", args: { path: "1-projects/allowed.md", content: "# Allowed\n\nKept.\n" } }] };

test("a reply waits for a late yes, and a late no rejects without waiting for the model", async () => {
  let yes;
  const gate = allowedBeside(new Promise((resolve) => (yes = resolve)));
  let replied = false;
  const held = besideAllowed(gate, Promise.resolve("words")).then((reply) => ((replied = true), reply));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(replied, false, "the model's reply is not handed on before the yes");
  yes();
  assert.equal(await held, "words");
  assert.ok(gate.heldMs > 0, "how long it was held is counted");

  let no;
  const refusing = allowedBeside(new Promise((_, reject) => (no = reject)));
  const never = new Promise(() => {});
  const cut = besideAllowed(refusing, never);
  const refusal = new Error("refused");
  no(refusal);
  await assert.rejects(cut, (error) => error === refusal);
  assert.ok(isRefusal(refusing, refusal) && !isRefusal(refusing, new Error("other")) && !isRefusal(null, refusal));
  await assert.rejects(besideAllowed(refusing, Promise.resolve("late")), (error) => error === refusal, "a known no rejects at once");
});

test("a late yes holds the round's tools until it comes, then the turn goes on", async () => {
  const world = await createEgressWorld();
  try {
    const { verdict, answer } = lateVerdict();
    world.controlPlane.setBuiltinVerdict("ws_egress", verdict);
    world.model.install([WRITE, { text: "Saved it." }]);
    const asked = request(world.env, TOKEN_TEXTS, "/agent", { question: "Save a note called allowed.", conversation: "texts" });
    await until(() => world.model.requests.length === 1, "the first model round");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(world.model.requests.length, 1, "no second round: the round's tool waits for the yes");
    assert.equal(written(world), 0, "nothing written before the yes");
    answer(BUILTIN_ALLOWED);
    const done = await asked;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.answer, "Saved it.");
    assert.equal(written(world), 1, "written once allowed");
  } finally {
    world.restore();
  }
});

test("a late no runs nothing the round asked for, keeps nothing, and meters nothing", async () => {
  const world = await createEgressWorld();
  try {
    const { verdict, answer } = lateVerdict();
    world.controlPlane.setBuiltinVerdict("ws_egress", verdict);
    world.model.install([WRITE, { text: "Saved it." }]);
    const reportsBefore = world.controlPlane.builtinReports.length;
    const asked = request(world.env, TOKEN_TEXTS, "/agent", { question: "Save a note called allowed.", conversation: "texts" });
    await until(() => world.model.requests.length === 1, "the first model round");
    answer(DAILY_CAP);
    const done = await asked;
    assert.equal(done.status, 429, JSON.stringify(done.body));
    assert.equal(done.body.error, "daily_limit");
    assert.equal(world.model.requests.length, 1, "no round after the no");
    assert.equal(written(world), 0, "the round's write never ran");
    assert.equal(world.controlPlane.builtinReports.length, reportsBefore, "a refused turn reports no spend");
  } finally {
    world.restore();
  }
});

test("a no already known spends no model call", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.setBuiltinVerdict("ws_egress", { allowed: false, reason: "not_premium" });
    world.model.install([{ text: "Hi." }]);
    const done = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts" });
    assert.equal(done.status, 409);
    assert.equal(done.body.error, "no_provider");
    assert.equal(world.model.requests.length, 0);
  } finally {
    world.restore();
  }
});
