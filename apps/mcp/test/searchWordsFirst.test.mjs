// The word search reaches a workspace's object before the meaning warm-up does (`src/search/wordsFirst.js`): an
// object answers one call at a time, and in a large workspace the warm-up's read of the meaning index held the word
// search until meaning came back, so the reranker on word hits could never start early (live, 2026-11-21).
// Sabotage: drop `wordSearchAsked` in `visibleNotes.js`, or `afterWordSearch` in `objectMeaningWarm`, and the
// first test fails.
import test from "node:test";
import assert from "node:assert/strict";
import { searchVisibleNotes } from "../src/search/visibleNotes.js";
import { objectMeaningWarm } from "../src/search/meaning/objectMeaning.js";
import { afterWordSearch, wordSearchAsked } from "../src/search/wordsFirst.js";

const ticks = async (n = 20) => {
  for (let i = 0; i < n; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test("the meaning warm-up is sent only once the word search started beside it has answered", async () => {
  const sent = [];
  let answer;
  const store = {
    defer: () => {},
    objectSearch: {
      search: (asks) => {
        sent.push("ws.search");
        return new Promise(
          (resolve) => (answer = () => resolve({ served: false, waiting: 1 })),
        );
      },
    },
    objectMeaning: {
      meaningWarm: async () => {
        sent.push("ws.meaning.warm");
        return { served: true, loaded: true };
      },
    },
  };
  // As the search graph starts them, in the same tick, and in either order.
  const warm = objectMeaningWarm(store);
  const words = searchVisibleNotes(
    store,
    "private",
    null,
    null,
    "willow harbor",
    "",
  ).catch(() => null);
  await ticks();
  assert.deepEqual(
    sent,
    ["ws.search"],
    "the warm-up waits while the word search is in flight",
  );
  answer();
  await warm;
  await words;
  assert.deepEqual(sent.slice(0, 2), ["ws.search", "ws.meaning.warm"]);
});

test("with no word search in flight the warm-up goes at once, and a failed word search still lets it go", async () => {
  const calls = [];
  const store = {
    objectMeaning: {
      meaningWarm: async () => (
        calls.push("warm"),
        { served: true, loaded: false }
      ),
    },
  };
  await objectMeaningWarm(store);
  assert.deepEqual(calls, ["warm"]);

  wordSearchAsked(store, Promise.reject(new Error("down")));
  await objectMeaningWarm(store);
  assert.deepEqual(calls, ["warm", "warm"]);

  // Another store's word search holds nothing here.
  let release;
  wordSearchAsked({}, new Promise((resolve) => (release = resolve)));
  await objectMeaningWarm(store);
  assert.deepEqual(calls, ["warm", "warm", "warm"]);
  release();
  await afterWordSearch(null);
  await afterWordSearch(undefined);
});
