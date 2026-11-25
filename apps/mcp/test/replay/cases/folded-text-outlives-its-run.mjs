import assert from "node:assert/strict";
import { acceptGroup, drainGroup } from "../../../../../packages/tex/worker/groupInbox.ts";
import { MemoryStorage } from "../../../../../packages/tex/worker/memoryStorage.testing.ts";
import { answerAll, LINES, setup } from "../../../../../packages/tex/worker/groupWorld.testing.ts";

const { groupId } = LINES[0];

/** One group: the asker's text starts a turn that is held open, and their next text lands while it runs. */
async function run(agent) {
  const storage = new MemoryStorage();
  const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : answerAll(body)), ...(agent ? { agent } : {}) });
  await acceptGroup(storage, w.message("Tex stick the frog sticker"), 0);
  const draining = drainGroup(storage, w.deps);
  await w.running;
  assert.equal(await acceptGroup(storage, w.message("try again"), 10), "queued");
  w.release();
  await draining;
  await drainGroup(storage, w.deps);
  return w;
}

export default {
  id: "folded-text-outlives-its-run",
  incident:
    "2026-11-25, Tex Devs: Sayo stuck a sticker on Tex's text and sent \"try again\" 0.6 s later. Decide said \"try again\" was for Tex and folded it into the run already going (the early run the sticker started); Decide then stopped that run as quiet, and \"try again\" was never answered until a check-in hours later.",
  cause:
    "A folded text was only handed to the running turn, never kept in the queue, so a turn that ended without taking it in (stopped, cancelled, or never reading it) lost it. It now waits in the queue beside the turn: the turn's own report of what it took in removes it, and anything else leaves it for the drain to answer on its own.",
  path: "group text",
  async run() {
    // The turn takes it in (the gateway reports it steered): one answer covers both, never a second.
    const took = await run();
    assert.equal(took.asks.length, 1);
    assert.equal(took.texts.filter((text) => text.startsWith("answer to")).length, 1);
    // The turn ends without it: it is answered as its own turn after.
    const lost = await run((body) => ({ answer: `answer to ${body.question}` }));
    assert.deepEqual(lost.steers.map((steer) => steer.text), ["try again"]);
    assert.deepEqual(lost.asks.map((ask) => ask.question), ["Tex stick the frog sticker", "try again"]);
  },
};
