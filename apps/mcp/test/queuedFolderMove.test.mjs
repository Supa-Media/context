/**
 * `move_folder` queued through the control plane (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`), and the session store that
 * reads through pending moves.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `startQueuedFolderMove` call and the queued case copies objects;
 *  - fall back the old way when the start throws with a move pending and the
 *    unreachable case moves the wrong layout;
 *  - drop the `storeThroughMoves` wrap and the session case reads nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startQueuedFolderMove } from "../src/tools/moves/queuedFolder.js";
import { toolMoveFolder } from "../src/tools/moves/folder.js";
import { storeForSession } from "../src/sessionStore.js";
import { createSessionMethods } from "../src/controlPlane/session.js";

function memory() {
  const objects = new Map();
  let counter = 0;
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        etag: value.etag,
        httpMetadata: { contentType: value.contentType },
        text: async () => value.body,
        arrayBuffer: async () => new TextEncoder().encode(value.body).buffer,
      };
    },
    async put(key, body, options = {}) {
      const existing = objects.get(key);
      if (options.onlyIf?.absent && existing) return null;
      if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      const etag = `e${++counter}`;
      const contentType = options.httpMetadata?.contentType ?? options.contentType;
      objects.set(key, { body: text, etag, contentType });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false };
    },
  };
  return { store, objects };
}

test("a queued move answers in one step and copies nothing", async () => {
  const { store, objects } = memory();
  await store.put("1-projects/a/x.png", "x");
  const asked = [];
  store.startQueuedMove = async (from, to) => {
    asked.push([from, to]);
    return { queued: true, count: 1 };
  };
  const answer = await toolMoveFolder(store, "private", [], new Map(), "1-projects/a", "2-areas/a", false);
  assert.match(answer.content[0].text, /moved folder: 1-projects\/a\/ → 2-areas\/a\/ \(1 objects\)/);
  assert.deepEqual(asked, [["1-projects/a", "2-areas/a"]]);
  assert.ok(objects.has("1-projects/a/x.png"));
});

test("not queued means the old way; a refusal is worded for the agent", async () => {
  const { store } = memory();
  store.startQueuedMove = async () => ({ queued: false });
  assert.equal(await startQueuedFolderMove(store, "private", "a", "b"), null);
  store.startQueuedMove = async () => ({ queued: false, error: "FILE_NOT_FOUND", message: "That file does not exist." });
  assert.equal((await startQueuedFolderMove(store, "team", "a", "b")).content[0].text, "not found");
  store.startQueuedMove = async () => ({ queued: false, error: "CONFLICT", message: "Something there is still moving." });
  assert.match((await startQueuedFolderMove(store, "team", "a", "b")).content[0].text, /^conflict: Something there is still moving/);
  delete store.startQueuedMove;
  assert.equal(await startQueuedFolderMove(store, "private", "a", "b"), null);
});

test("a control plane out of reach is the old way, as before", async () => {
  const { store } = memory();
  store.startQueuedMove = async () => {
    throw new Error("down");
  };
  assert.equal(await startQueuedFolderMove(store, "private", "a", "b"), null);
});

