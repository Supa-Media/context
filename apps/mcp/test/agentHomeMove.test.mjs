// The one move of a workspace's old Tex bookkeeping into its Tex object (src/agent/agentHomeMove.js):
// the history becomes the one record, turn records keep their verdict (a false always wins), nothing in the
// bucket is deleted, and running it again moves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { serveTexStore, texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { storeForBinding } from "../src/store/factory.js";
import { eventKey } from "../src/agent/events.js";
import { moveAgentHome } from "../src/agent/agentHomeMove.js";
import { readConversation } from "../src/agent/conversation.js";
import { durableSql } from "./texStoreFixture.mjs";

function world() {
  const bucketObjects = texObjects(durableSql());
  const bucket = texBucket({ fetch: (request) => serveTexStore(bucketObjects, request) });
  const person = texObjects(durableSql());
  const texStore = (owner) => (owner === "person:w1" ? new R2Store(texBucket({ fetch: (request) => serveTexStore(person, request) })) : null);
  const env = { NATIVE_BINDINGS: "BUCKET", BUCKET: bucket };
  const binding = { provider: "r2-binding", bindingName: "BUCKET", workspaceId: "w1", conditionalWrite: true, conditionalCreate: true };
  const store = storeForBinding(binding, env, { texStore });
  const raw = new R2Store(bucket);
  const bucketKeys = () => bucketObjects.list({}).objects.map((object) => object.key);
  const personKeys = () => person.list({}).objects.map((object) => object.key);
  return { store, raw, bucketKeys, personKeys, person };
}

test("the old log becomes the one record, turn records keep their verdict, and nothing in the bucket goes", async () => {
  const { store, raw, bucketKeys, personKeys } = world();
  await raw.put(eventKey(1_000, "a1"), JSON.stringify({ v: 1, at: 1_000, question: "first", answer: "one" }));
  await raw.put(eventKey(2_000, "a2"), JSON.stringify({ v: 1, at: 2_000, question: "second", answer: "two" }));
  await raw.put(".context/agent/turns/turn-clean-0001.json", JSON.stringify({ clean: true }));
  await raw.put(".context/agent/turns/turn-dirty-0001.json", JSON.stringify({ clean: false }));
  const before = bucketKeys();

  const dry = await moveAgentHome(store, { dryRun: true });
  assert.deepEqual(dry, { history: "would", turns: { copied: 0, kept: 0, would: 2 } });
  assert.deepEqual(personKeys(), [], "a dry run writes nothing");

  // A record already says not clean for the clean one: the move never launders it.
  await store.put(".context/agent/turns/turn-clean-0001.json", JSON.stringify({ clean: false }));
  const moved = await moveAgentHome(store);
  assert.deepEqual(moved, { history: "moved", turns: { copied: 1, kept: 1, would: 0 } });
  assert.deepEqual((await readConversation(store, "texts")).map((turn) => turn.text), ["first", "one", "second", "two"]);
  const verdict = async (turn) => JSON.parse(await (await store.get(`.context/agent/turns/${turn}.json`)).text()).clean;
  assert.equal(await verdict("turn-clean-0001"), false);
  assert.equal(await verdict("turn-dirty-0001"), false);
  assert.deepEqual(bucketKeys(), before, "the bucket keeps everything, as the way back");

  const again = await moveAgentHome(store);
  assert.equal(again.history, "already");
});

test("a workspace with no old history gets no record from the move", async () => {
  const { store, personKeys } = world();
  assert.deepEqual(await moveAgentHome(store), { history: "none", turns: { copied: 0, kept: 0, would: 0 } });
  assert.deepEqual(personKeys(), []);
});
