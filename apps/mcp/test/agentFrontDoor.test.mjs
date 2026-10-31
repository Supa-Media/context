/**
 * TEX'S FRONT DOOR (`src/agent/frontDoor.js`; Seyi, 2026-10-31: a one-to-one
 * "hi Tex" took about three minutes, 3.5 seconds of it the model).
 *
 * A text goes to the model and its answer comes back with nothing of the old
 * turn around it: no reply checks, the waiting asks listed once, the chat saved
 * after the answer. A yes or no on a held change is still matched in code
 * before any model runs, and `front_door: off` brings the old turn back.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `!front ||` dropped from `claims` in `route.js`: "an answer that claims a
 *    change goes out as it is" fails (the claim check sends it back);
 *  - `waitingAsks` returning null: "the model is told one still waits"
 *    fails;
 *  - `front_door` read as always on: "off brings the old turn back" fails;
 *  - `textedAsk` handing its disarm to a host deferral: "a reply that asks
 *    something disarms the older ask before it answers" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { mayAnswerAsk, readFrontDoor } from "../src/agent/frontDoor.js";
import { textedAsk } from "../src/agent/textedApprovals.js";
import { createPending, listPending } from "../src/tools/approvals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const claim = (slug) => ({ toolCalls: [{ name: "create_workspace", args: { slug, name: slug } }] });

test("only a yes, a no or a tapback is matched against the waiting asks", () => {
  assert.equal(mayAnswerAsk("hi Tex", {}, false), false);
  assert.equal(mayAnswerAsk("what's on Friday?", {}, false), false);
  assert.equal(mayAnswerAsk("yes", {}, false), true);
  assert.equal(mayAnswerAsk("no", {}, false), true);
  assert.equal(mayAnswerAsk("yes", {}, true), false, "a yes with a photo is about the photo");
  assert.equal(mayAnswerAsk("", { tapback: "Liked", words: "Give it a 👍" }, false), true);
});

test("front_door is on unless a setup says off, and anything else is a broken setup", () => {
  assert.equal(readFrontDoor(undefined), true);
  assert.equal(readFrontDoor("on"), true);
  assert.equal(readFrontDoor("off"), false);
  assert.equal(readFrontDoor("maybe"), null);
});

test("an answer that claims a change goes out as it is: one model round, no reply checks", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Done, I updated your note." }, { text: "second round" }]);
    const asked = await ask(world.env, TOKEN_TEXTS, "hi Tex");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Done, I updated your note.");
    assert.equal(world.model.requests.length, 1);
  } finally {
    world.restore();
  }
});

test("off brings the old turn back: the same answer is sent back once by the claim check", async () => {
  const world = await createEgressWorld();
  try {
    world.env.TEX_FRONT_DOOR = "off";
    world.model.install([{ text: "Done, I updated your note." }, { text: "Nothing changed yet." }]);
    const asked = await ask(world.env, TOKEN_TEXTS, "hi Tex");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(world.model.requests.length, 2);
  } finally {
    world.restore();
  }
});

test("on any other text the model is told one still waits, and a yes still releases it with no model", async () => {
  const world = await createEgressWorld();
  const { model, env, controlPlane } = world;
  const claimed = (slug) => controlPlane.workspaceSetupCalls.some((entry) => entry.dryRun === false && entry.slug === slug);
  try {
    model.install([claim("front-co"), { text: "Want @front-co?" }]);
    await ask(env, TOKEN_TEXTS, "set up front co");
    assert.equal(claimed("front-co"), false, "held for their yes");

    model.install([{ text: "Hey Seyi." }]);
    const hi = await ask(env, TOKEN_TEXTS, "hi Tex");
    assert.equal(hi.status, 200, JSON.stringify(hi.body));
    assert.match(JSON.stringify(model.requests.at(-1)), /it still waits/);

    const before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(model.requests.length, before, "a yes is matched in code, never by the model");
    assert.equal(claimed("front-co"), true);
  } finally {
    world.restore();
  }
});

test("the chat is still kept: the next text's turn sees the last one", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Hey Seyi." }]);
    await ask(world.env, TOKEN_TEXTS, "hi Tex");
    world.model.install([{ text: "You said hi." }]);
    await ask(world.env, TOKEN_TEXTS, "what did I just say?");
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /hi Tex/);
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /Hey Seyi\./);
  } finally {
    world.restore();
  }
});

/*
  THE DISARM THAT PROTECTS A LATER YES IS NEVER LEFT TO THE HOST.

  When Tex's own reply asks something, `textedAsk` disarms the texting asks
  held before it, so the bare "yes" that answers the new question cannot
  release an older one (an email, a handle claim, a vault key's first use).
  `askOvertaken` is no second check here: it counts only Tex texts kept under
  "(Not a text from them.", and an ordinary reply is not one.

  So this disarm is the whole protection and must land before the turn
  answers. A host's deferral (`store.defer`, `ctx.waitUntil`) is "an
  optimisation it may not get, never where the work happens"
  (`src/http/route.js`), and the suite is given no deferral at all, which is
  why the behaviour cannot be seen through the worker here and the contract is
  asserted instead: a `defer` that takes the work and returns at once, as a
  host does, must not stop the record being gone by the time `textedAsk`
  resolves. The delete is made slow so an unawaited one is visibly armed.
*/
test("a reply that asks something disarms the older ask before it answers", async () => {
  const kept = createMemoryStore();
  const slow = { ...kept, delete: async (key) => { await new Promise((resolve) => setTimeout(resolve, 0)); return kept.delete(key); } };
  const summary = "email jo";
  await createPending(slow, {
    name: "send_email",
    args: { summary },
    actor: { userId: "u1", clientId: "context_texts" },
    widening: { summary },
    detail: "To: jo@example.com\n\nshort",
    texting: true,
  });
  assert.equal((await listPending(slow, { userId: "u1", texting: true })).length, 1);
  await textedAsk(slow, { actorUserId: "u1" }, [], "Sure, what time?", { defer: () => undefined });
  assert.equal((await listPending(slow, { userId: "u1", texting: true })).length, 0, "the older ask is still armed: a bare yes would release it");
});
