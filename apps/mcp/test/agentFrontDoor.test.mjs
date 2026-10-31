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
 *  - `front_door` read as always on: "off brings the old turn back" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { mayAnswerAsk, readFrontDoor } from "../src/agent/frontDoor.js";

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
