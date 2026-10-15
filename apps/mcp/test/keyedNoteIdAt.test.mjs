/**
 * The keyed id layer answers the collaboration engine's question, "which note
 * is at this name?" (`store/idLayout.js`, `noteIdAt`). A head is made for one
 * note id, and the engine refuses to attach a head to a different note at the
 * same name (`packages/collaboration/src/load.js`, notes-by-id.md).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - answer the row's key instead of its note id: the id case fails;
 *  - answer an id for a path with no keyed row: the no-row case fails;
 *  - answer an id in the ids layout: the not-keyed case fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { idKeyFor } from "../src/store/noteIdKeys.js";
import { withIdLayout } from "../src/store/idLayout.js";

const NOTE = "0190a000-0000-7000-8000-00000000000a";
const PATH = "1-projects/a.md";

function bucket() {
  const objects = new Map();
  return {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? null : { etag: "e", text: async () => body };
    },
    async put(key, body) {
      objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      return { etag: "e" };
    },
  };
}

function hooks(notes, mode = "keys") {
  return {
    mode,
    lookup: async (paths) => ({
      copies: {},
      keyed: true,
      notes: Object.fromEntries(paths.filter((path) => notes[path]).map((path) => [path, notes[path]])),
    }),
    wrote: async () => ({ recorded: true }),
    adopt: async () => ({ adopted: true, taken: null }),
    removed: async () => ({ removed: true }),
  };
}

test("a keyed row's note id is what the engine is told about its name", async () => {
  const notes = { [PATH]: { state: "keyed", key: idKeyFor(NOTE, PATH), etag: "e", noteId: NOTE } };
  const layered = withIdLayout(bucket(), hooks(notes));

  assert.equal(await layered.noteIdAt(PATH), NOTE);
});

test("a name with no keyed row has no note id, and neither does plumbing", async () => {
  const layered = withIdLayout(bucket(), hooks({}));

  assert.equal(await layered.noteIdAt(PATH), null);
  assert.equal(await layered.noteIdAt(".context/collaboration/v1/heads/x.json"), null);
});

test("the ids layout does not answer note ids: the engine's check is off where there are no keyed rows", async () => {
  const notes = { [PATH]: { state: "keyed", key: idKeyFor(NOTE, PATH), etag: "e", noteId: NOTE } };
  const layered = withIdLayout(bucket(), hooks(notes, "ids"));

  assert.equal(layered.noteIdAt, undefined);
});
