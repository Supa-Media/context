/**
 * NOT TRIED IS NOT "I CAN'T OPEN IT", ON THE FRONT DOOR TOO (the Tex Devs
 * group, 2026-11-03; `src/agent/untriedWeb.js`). Asked "thoughts?" on a shared
 * claude.ai artifact, Tex answered "I still can't open that artifact … Paste
 * the main points here" with no web call in the turn, and the front door,
 * which runs no reply checks, let it go.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `tries` in `route.js` set to null: "an untried can't-open on the front
 *    door gets one round to try" fails (one model request, the give-up sent);
 *  - `triedWeb = true` dropped from the wrapper: "a can't-open after a real
 *    try goes out" fails (the notice fires after a try);
 *  - `noticed` never set: "once a turn" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { TRY_NOTICE } from "../src/agent/claimCheck.js";
import { LINK_LINE, systemPromptParts } from "../src/agent/prompt.js";
import { untriedWebCheck } from "../src/agent/untriedWeb.js";

const GAVE_UP = "I still can't open that artifact, so I can't weigh in on it yet. Paste the main points here and I'll give you a straight take.";
const web = () => ({ tools: [{ name: "open_page" }], usage: {}, call: async () => ({ content: [{ type: "text", text: "Address: https://example.com/\n\nwords" }] }) });

test("an untried can't-open is sent back once to try, and only when the turn had the web", async () => {
  const fresh = untriedWebCheck();
  fresh.wrapWeb(web());
  assert.equal(fresh.check(GAVE_UP), TRY_NOTICE);
  assert.equal(fresh.check(GAVE_UP), null, "once a turn");

  const offline = untriedWebCheck();
  assert.equal(offline.wrapWeb(null), null);
  assert.equal(offline.check(GAVE_UP), null, "a turn with no web has nothing to try");

  const other = untriedWebCheck();
  other.wrapWeb(web());
  assert.equal(other.check("Here's my take: ship it after the trace."), null, "an answer that doesn't give up passes");
});

test("a can't-open after a real try goes out", async () => {
  const tried = untriedWebCheck();
  await tried.wrapWeb(web()).call("open_page", { url: "https://example.com/" });
  assert.equal(tried.check(GAVE_UP), null);
});

test("an untried can't-open on the front door gets one round to try", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([
      { text: GAVE_UP },
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { text: "Read it: all fine." },
    ]);
    const asked = await ask(world.env, TOKEN_TEXTS, "thoughts? https://example.com/status");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Read it: all fine.");
    assert.equal(world.model.requests.length, 3);
    assert.match(JSON.stringify(world.model.requests[1]), /you didn't try anything on the web in this turn/);
  } finally {
    world.restore();
  }
});

test("any other front-door answer still goes out in one round", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Done, I updated your note." }, { text: "second round" }]);
    const asked = await ask(world.env, TOKEN_TEXTS, "hi Tex");
    assert.equal(asked.body.answer, "Done, I updated your note.");
    assert.equal(world.model.requests.length, 1);
  } finally {
    world.restore();
  }
});

test("a texted turn is told a link is read before it is talked about", () => {
  const said = JSON.stringify(systemPromptParts("texts", { texting: true }));
  assert.ok(said.includes(LINK_LINE.slice(0, 60)));
  assert.match(LINK_LINE, /never ask them to paste what a link holds/);
});
