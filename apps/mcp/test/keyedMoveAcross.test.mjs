/**
 * `move_note` into another workspace when either end is keyed
 * (`src/tools/moves/acrossKeyed.js`): the gateway asks the control plane's
 * engine, which carries the note and trashes the source, and writes no bytes
 * itself. A store with no control plane still refuses, as before
 * (`keyedWorkspaceRefusals.test.mjs`).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - call the path-based move instead of the engine: the keyed case writes bytes;
 *  - drop the etag check: the stale-version case asks the engine anyway;
 *  - read an engine refusal (`null`) as a move: the refused case says "moved".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolMoveNoteAcrossContexts } from "../src/tools/moves/acrossContexts.js";

/** A bucket fake that records every write, keyed or not as asked, with the engine seam. */
function workspace({ keyed, answer, files = {} }) {
  const objects = new Map(Object.entries(files));
  const writes = [];
  const asked = [];
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    keyedWorkspace: async () => keyed,
    async head(key) {
      const value = objects.get(key);
      return value === undefined ? null : { etag: value.etag, size: value.body.length };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return { etag: value.etag, httpMetadata: {}, text: async () => value.body };
    },
    async put(key) {
      writes.push(["put", key]);
      return { etag: "new" };
    },
    async delete(key) {
      writes.push(["delete", key]);
    },
    async list() {
      return { objects: [], truncated: false };
    },
    moveAcross: async (destinationWorkspaceId, from, to) => {
      asked.push({ destinationWorkspaceId, from, to });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { store, writes, asked };
}

const SOURCE = { scope: "private", workspaceId: "ws_source", workspaceSlug: "seyi" };
const DESTINATION = { scope: "private", workspaceId: "ws_destination", workspaceSlug: "supa" };
const NOTE = { "1-projects/plan.md": { body: "# Plan\n", etag: "e1" } };

async function move(source, destination, etag) {
  const result = await toolMoveNoteAcrossContexts(
    source.store, SOURCE, destination.store, DESTINATION, "1-projects/plan.md", "1-projects/plan.md", etag, true
  );
  return { text: result.content[0].text, isError: result.isError === true };
}

test("a keyed note moves through the engine, and the gateway writes nothing", async () => {
  const source = workspace({ keyed: true, files: NOTE, answer: { status: "complete", movedObjects: 1, skipped: [] } });
  const destination = workspace({ keyed: true });

  const { text, isError } = await move(source, destination, "e1");

  assert.equal(isError, false);
  assert.match(text, /^moved: @seyi\/1-projects\/plan\.md → @supa\/1-projects\/plan\.md/);
  assert.match(text, /trash/);
  assert.deepEqual(source.asked, [{ destinationWorkspaceId: "ws_destination", from: "1-projects/plan.md", to: "1-projects/plan.md" }]);
  assert.deepEqual(source.writes, []);
  assert.deepEqual(destination.writes, []);
});

test("either end keyed is enough to go through the engine", async () => {
  for (const [from, to] of [[true, false], [false, true]]) {
    const source = workspace({ keyed: from, files: NOTE, answer: { status: "complete", movedObjects: 1, skipped: [] } });
    const destination = workspace({ keyed: to });
    const { isError } = await move(source, destination);
    assert.equal(isError, false);
    assert.equal(source.asked.length, 1);
    assert.deepEqual([...source.writes, ...destination.writes], []);
  }
});

test("a version the caller read that is no longer current stops the move before the engine is asked", async () => {
  const source = workspace({ keyed: true, files: NOTE, answer: { status: "complete", movedObjects: 1, skipped: [] } });
  const { text, isError } = await move(source, workspace({ keyed: true }), "stale");
  assert.equal(isError, true);
  assert.match(text, /^conflict: source changed since you read it \(current etag e1\)/);
  assert.deepEqual(source.asked, []);
});

test("the engine's refusals come back as errors, never as a move", async () => {
  const cases = [
    [null, /^permission denied: moving a note out of @seyi needs owner access/],
    [{ status: "failed", movedObjects: 0, skipped: [], error: "Something already exists at 1-projects/plan.md." }, /^not moved: Something already exists/],
    [{ status: "complete", movedObjects: 0, skipped: [{ path: "1-projects/plan.md", reason: "encrypted" }] }, /^not moved: .*encrypted/],
    [new Error("socket hang up"), /^the move could not be confirmed; check @seyi\/1-projects\/plan\.md and @supa\/1-projects\/plan\.md/],
  ];
  for (const [answer, expected] of cases) {
    const source = workspace({ keyed: true, files: NOTE, answer });
    const { text, isError } = await move(source, workspace({ keyed: true }));
    assert.equal(isError, true, text);
    assert.match(text, expected);
    assert.doesNotMatch(text, /^moved:/);
  }
});

test("two workspaces that are not keyed never ask the engine", async () => {
  const source = workspace({ keyed: false, files: NOTE, answer: { status: "complete", movedObjects: 1, skipped: [] } });
  await move(source, workspace({ keyed: false }));
  assert.deepEqual(source.asked, []);
});
