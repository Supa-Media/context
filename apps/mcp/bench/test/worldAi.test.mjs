/**
 * Which Workers AI binding a socketed run's world gets (`bench/worldAi.mjs`, used by `run.mjs` answerJobs).
 *
 * Sabotage: make worldAi ignore `REAL_CLEF_ENV` and the first test fails (Clef back on the stand-in, every live pick
 * "none"); make it honour a Claude-only socket without the flag and the replay-gate test fails; route the embeddings to
 * the real binding and the embeddings assertion fails. The landmine test records why the stand-in must not answer the
 * front door's live Clef: its answer has `tier`, not the `route.choice` the specialist router reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REAL_CLEF_ENV, worldAi } from "../worldAi.mjs";
import { fakeAi } from "../models.mjs";
import { decisionEngine } from "../../../../packages/tex/gateway/agent/decide.js";
import { readRoute, routeRequest } from "../../../../packages/tex/gateway/agent/specialistRoute.js";
import { MEANING_MODEL } from "../../src/search/meaning/embed.js";

const CLEF = "@cf/cloudflare/clef";
const realStub = () => {
  const calls = [];
  return { calls, run: async (model, input, options) => (calls.push({ model, options }), { answers: { route: { choice: "read", confidence: 0.9 } } }) };
};
const claudeOnly = { covers: (kind) => kind === "claude" };
const withWorkersAi = { covers: (kind) => kind === "claude" || kind === "workers-ai" };

test("a Claude-only socket asked for real Clef answers Clef on benchModels' binding; embeddings stay on the stand-in", async () => {
  const real = realStub();
  const ai = worldAi({ socket: claudeOnly, socketed: true, currentAi: real, env: { [REAL_CLEF_ENV]: "1" } });
  const asked = routeRequest({ question: "what is on my calendar tomorrow" });
  const answers = await decisionEngine(ai)(asked.state, asked.questions);
  assert.ok(readRoute(answers), "the router reads a route from the real binding");
  assert.equal(real.calls[0].model, CLEF);
  await ai.run("@cf/zai-org/glm", { messages: [] }, { gateway: { id: "g" } });
  assert.deepEqual(real.calls.at(-1), { model: "@cf/zai-org/glm", options: { gateway: { id: "g" } } }, "a call's options pass through");
  const before = real.calls.length;
  await ai.run(MEANING_MODEL, { text: ["hello"] });
  assert.equal(real.calls.length, before, "embeddings never reach the real binding");
});

test("a Claude-only socket without the flag (the replay gate, live and replayed) keeps the stand-in", () => {
  const real = realStub();
  const ai = worldAi({ socket: claudeOnly, socketed: true, currentAi: real, env: {} });
  assert.notEqual(ai, real);
});

test("a socket that covers workers-ai gets the stand-in, flag or not", () => {
  const real = realStub();
  for (const env of [{}, { [REAL_CLEF_ENV]: "1" }]) {
    const ai = worldAi({ socket: withWorkersAi, socketed: true, currentAi: real, env });
    assert.notEqual(ai, real);
    assert.equal(typeof ai.run, "function");
  }
});

test("a run that is not socketed keeps benchModels' Workers AI", () => {
  const real = realStub();
  assert.equal(worldAi({ socket: null, socketed: false, currentAi: real, env: {} }), real);
  assert.equal(worldAi({ socket: withWorkersAi, socketed: false, currentAi: real, env: {} }), real);
});

test("landmine: the scripted stand-in answers Clef with tier, so the router reads no route from it", async () => {
  // The router's own call (`graph/nodes/router.js`): decisionEngine over the binding, the question from routeRequest,
  // the answers through readRoute. Every route question must read as null on the stand-in, which is why it must stay
  // off a Claude-only run.
  const engine = decisionEngine(fakeAi());
  for (const question of ["send Sam the invoice", "what is on my calendar tomorrow", "should I move the dentist"]) {
    const asked = routeRequest({ question });
    const answers = await engine(asked.state, asked.questions);
    assert.ok(answers?.tier, "the stand-in answers the tier shape");
    assert.equal(readRoute(answers), null, `no route read for: ${question}`);
  }
});
