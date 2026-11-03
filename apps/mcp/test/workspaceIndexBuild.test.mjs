// The search indexes caught up on the workspace object's alarm (src/workspaceStore/indexBuild.js): a build that
// leaves changes waiting asks for the alarm, one that finishes does not, a failure backs off, and nothing is built
// while the object is not where the notes live.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKOFF_MS, GAP_MS, indexBuilder } from "../src/workspaceStore/indexBuild.js";
import { HOMES } from "../src/workspaceStore/api.js";

function storeWith({ home = HOMES.OBJECT, words = [0], meaning = [{ waiting: 0 }] } = {}) {
  const calls = { words: 0, meaning: 0 };
  return {
    calls,
    rows: { home: () => home },
    search: {
      catchUp: () => {
        const answer = words[Math.min(calls.words, words.length - 1)];
        calls.words += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    meaning: {
      catchUp: async () => {
        const answer = meaning[Math.min(calls.meaning, meaning.length - 1)];
        calls.meaning += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

// Sabotage: make `noted` ignore `waiting` and the alarm is never asked for.
test("a build call that leaves changes waiting asks for the alarm; one that finishes does not", () => {
  const builder = indexBuilder(storeWith(), { now: () => 100 });
  builder.noted({ served: true, waiting: 0 });
  assert.equal(builder.wake(), null);
  builder.noted({ served: true, waiting: 7 });
  assert.equal(builder.wake(), 100 + GAP_MS);
  builder.noted(3);
  assert.equal(builder.wake(), 100 + GAP_MS, "an earlier wake stands");
});

// Sabotage: set `wakeAt` after a build whatever it left, and the alarm runs forever.
test("the alarm builds both indexes until nothing waits, then stops", async () => {
  const store = storeWith({ words: [5, 0], meaning: [{ waiting: 300 }, { waiting: 0 }] });
  const builder = indexBuilder(store, { now: () => 100 });
  builder.noted({ waiting: 1 });
  await builder.run();
  assert.equal(builder.wake(), 100 + GAP_MS);
  await builder.run();
  assert.equal(builder.wake(), null);
  assert.deepEqual(store.calls, { words: 2, meaning: 2 });
});

test("a build another call is running counts as waiting", async () => {
  const builder = indexBuilder(storeWith({ meaning: [{ busy: true, waiting: 0 }] }), { now: () => 100 });
  await builder.run();
  assert.equal(builder.wake(), 100 + GAP_MS);
});

// Sabotage: wake after `GAP_MS` on a failure and a model outage is an alarm a second.
test("a failed build backs off, and a failure answered to a build call does too", async () => {
  const builder = indexBuilder(storeWith({ meaning: [new Error("down")] }), { now: () => 100 });
  await builder.run();
  assert.equal(builder.wake(), 100 + BACKOFF_MS);
  const other = indexBuilder(storeWith(), { now: () => 100 });
  other.noted({ served: true, failed: true, waiting: null });
  assert.equal(other.wake(), 100 + BACKOFF_MS);
});

test("nothing is built, and no alarm asked for, while the object is not the notes' home; no rules or model is nothing waiting", async () => {
  const away = storeWith({ home: HOMES.BUCKET, words: [9], meaning: [{ waiting: 9 }] });
  const builder = indexBuilder(away, { now: () => 100 });
  builder.noted({ waiting: 1 });
  await builder.run();
  assert.equal(builder.wake(), null);
  assert.deepEqual(away.calls, { words: 0, meaning: 0 });
  const unready = indexBuilder(storeWith({ words: [null], meaning: [null] }), { now: () => 100 });
  await unready.run();
  assert.equal(unready.wake(), null);
});
