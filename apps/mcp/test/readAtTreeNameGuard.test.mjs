/**
 * `readAtTreeName` is the one read that deliberately goes around the guard a
 * pending move puts in front of an old bucket key (`withPendingMoves`, which
 * answers "not found" at a name a move is carrying away). Search needs it:
 * both indexes hold notes at their physical keys, and a queued folder move
 * leaves those keys where they are until its copy lands.
 *
 * Going around that guard is only safe while the caller is judged at the name
 * the tree draws instead. So the visibility check is the whole of the
 * protection, and a caller that supplies none must get nothing — not the
 * bytes. These pin that the gate is closed by default rather than open:
 * without them, omitting `isVisible` reads the note through `getStillAt`,
 * which is the unwrapped store's own `get`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readAtTreeName, withPendingMoves } from "../src/moves/queued.js";

/** A store holding one note, with one folder move queued over it. */
function movingStore() {
  const reads = [];
  const base = {
    get: async (key) => {
      reads.push(key);
      return key === "1-projects/secret/plan.md" ? { text: async () => "# Plan\n\nthe body\n" } : null;
    },
  };
  const store = withPendingMoves(base, [{ from: "1-projects/secret", to: "4-archive/secret", kind: "folder" }]);
  return { store, reads };
}

const OLD_KEY = "1-projects/secret/plan.md";
const NEW_NAME = "4-archive/secret/plan.md";

test("a moving note is not read when the caller supplies no visibility check", async () => {
  const { store, reads } = movingStore();
  assert.equal(await readAtTreeName(store, OLD_KEY), null);
  assert.deepEqual(reads, [], "the bytes must not be fetched at all");
});

test("a moving note is not read when it is not visible at the name the tree draws", async () => {
  const { store, reads } = movingStore();
  assert.equal(await readAtTreeName(store, OLD_KEY, (path) => path !== NEW_NAME), null);
  assert.deepEqual(reads, []);
});

test("a moving note is read when it is visible at the name the tree draws", async () => {
  const { store } = movingStore();
  const object = await readAtTreeName(store, OLD_KEY, (path) => path === NEW_NAME);
  assert.ok(object, "a visible note still answers");
  assert.match(await object.text(), /the body/);
});

test("a key no move carries is read as it always was, with or without a check", async () => {
  const { store } = movingStore();
  // Not under the moving folder: the ordinary path, no visibility argument needed.
  assert.equal(await readAtTreeName(store, "2-areas/other.md"), null);
  const base = { get: async () => ({ text: async () => "plain" }) };
  assert.ok(await readAtTreeName(base, "2-areas/other.md"));
});
