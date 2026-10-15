/**
 * A note or folder moved in a keyed workspace (`docs/decisions/storage-and-credentials/notes-by-id.md`):
 * the gateway asks the control plane for a row move and writes no bytes, and
 * a workspace that is not keyed yet moves the old way, as it always has.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `startKeyedNoteMove` call in `toolMoveNote` and the keyed case copies bytes;
 *  - answer `null` from a keyed refusal and the refused case moves the frozen copy;
 *  - drop the `keyedLayout` gate and the old-layout case asks the control plane;
 *  - drop the etag from the control plane call and the stale-version case moves anyway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { toolMoveFolder } from "../src/tools/moves/folder.js";
import { toolArchiveNote } from "../src/tools/moves/archive.js";
import { toolMoveNotes } from "../src/tools/moves/notes.js";

/** A bucket fake with the methods a note move reads and writes. */
function bucket(files) {
  const objects = new Map(Object.entries(files));
  const writes = [];
  let counter = 0;
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    async head(key) {
      const value = objects.get(key);
      return value === undefined ? null : { etag: value.etag, size: value.body.length };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        etag: value.etag,
        httpMetadata: {},
        text: async () => value.body,
        arrayBuffer: async () => new TextEncoder().encode(value.body).buffer,
      };
    },
    async put(key, body, options = {}) {
      writes.push(["put", key]);
      if (options.onlyIf?.absent && objects.has(key)) return null;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      const etag = `e${++counter}`;
      objects.set(key, { body: text, etag });
      return { etag };
    },
    async delete(key) {
      writes.push(["delete", key]);
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false };
    },
  };
  return { store, objects, writes };
}

/** The writes that touch note bytes: not the activity record (`.context/audit/`, `activity.md`). */
function noteWrites(writes) {
  return writes.filter(([, key]) => !key.startsWith(".context/") && key !== "activity.md");
}

/** A store with the control plane's answer to a move, recording what it was asked. */
function keyed(files, answer, { keyedLayout = true } = {}) {
  const made = bucket(files);
  const asked = [];
  made.store.keyedLayout = keyedLayout;
  made.store.startQueuedMove = async (from, to, expectedEtag) => {
    asked.push({ from, to, expectedEtag });
    return typeof answer === "function" ? answer() : answer;
  };
  return { ...made, asked };
}

test("a keyed note moves as a row change: the control plane is asked, no bytes are written", async () => {
  const made = keyed({ "1-projects/a.md": { body: "# A\n", etag: "e1" } }, { queued: true, count: 1, rowed: true });

  const answer = await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md", "e1");

  assert.match(answer.content[0].text, /moved note: 1-projects\/a\.md → 2-areas\/a\.md/);
  assert.deepEqual(made.asked, [{ from: "1-projects/a.md", to: "2-areas/a.md", expectedEtag: "e1" }]);
  // Only the activity record is written; no note's bytes are copied, deleted or created.
  assert.deepEqual(noteWrites(made.writes), []);
  assert.ok(made.objects.has("1-projects/a.md"));
});

test("a keyed refusal is said to the caller, and the bytes are not moved the old way", async () => {
  const made = keyed(
    { "1-projects/a.md": { body: "# A\n", etag: "e1" } },
    { queued: false, error: "CONFLICT", message: "That note changed somewhere else after this was asked for." },
  );

  const answer = await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md", "stale");

  assert.match(answer.content[0].text, /^conflict: That note changed somewhere else/);
  assert.deepEqual(noteWrites(made.writes), []);
});

test("a workspace whose layout is not keyed does not ask the control plane, and moves the old way", async () => {
  const made = keyed({ "1-projects/a.md": { body: "# A\n", etag: "e1" } }, { queued: true, count: 1, rowed: true }, { keyedLayout: false });

  const answer = await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.doesNotMatch(answer.content[0].text, /moved note: /);
  assert.deepEqual(made.asked, []);
  assert.ok(made.objects.has("2-areas/a.md"));
});

test("a keyed layout whose flip has not started answers no move, and the note moves the old way", async () => {
  const made = keyed({ "1-projects/a.md": { body: "# A\n", etag: "e1" } }, { queued: false });

  await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.equal(made.asked.length, 1);
  assert.ok(made.objects.has("2-areas/a.md"));
});

test("a keyed archive is a row change to the archive root, and copies no bytes", async () => {
  const made = keyed({ "1-projects/a.md": { body: "# A\n", etag: "e1" } }, { queued: true, count: 1, rowed: true });
  // Without conditional delete the note is not read as a collaborative document, so its etag is the object's.
  made.store.capabilities.conditionalDelete = false;

  const rules = [{ prefix: "4-archive", vis: "team" }];
  const answer = await toolArchiveNote(made.store, "private", rules, new Map(), "1-projects/a.md", "e1");

  assert.match(answer.content[0].text, /moved note: 1-projects\/a\.md → 4-archive\//);
  assert.equal(made.asked.length, 1);
  assert.equal(made.asked[0].from, "1-projects/a.md");
  assert.equal(made.asked[0].expectedEtag, "e1");
  assert.deepEqual(noteWrites(made.writes), []);
});

/** A keyed store whose control plane answers a batch with `answer`, recording each batch it is asked. */
function keyedBatch(files, answer) {
  const made = keyed(files, { queued: false });
  const batches = [];
  made.store.startMoveBatch = async (moves) => {
    batches.push(moves);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(moves) : answer;
  };
  return { ...made, batches };
}

const TWO_NOTES = {
  "1-projects/a.md": { body: "# A\n", etag: "e1" },
  "1-projects/b.md": { body: "# B\n", etag: "e2" },
};
const TWO_MOVES = [
  { source: "1-projects/a.md", destination: "2-areas/a.md", expected_source_etag: "e1" },
  { source: "1-projects/b.md", destination: "2-areas/b.md", expected_source_etag: "e2" },
];

test("a keyed batch is one control-plane call: every note moves as its row, and no bytes are written", async () => {
  const made = keyedBatch(TWO_NOTES, (moves) => ({ ok: true, moves: moves.map(({ from, to }) => ({ from, to })) }));

  const answer = await toolMoveNotes(made.store, "private", [], new Map(), TWO_MOVES, false);

  assert.match(answer.content[0].text, /moved notes: 2/);
  assert.deepEqual(made.batches, [
    [
      { from: "1-projects/a.md", to: "2-areas/a.md", expectedEtag: "e1" },
      { from: "1-projects/b.md", to: "2-areas/b.md", expectedEtag: "e2" },
    ],
  ]);
  assert.deepEqual(noteWrites(made.writes), []);
  assert.ok(made.objects.has("1-projects/a.md") && made.objects.has("1-projects/b.md"));
});

test("a keyed batch the control plane refuses is said to the caller, and no note moves", async () => {
  const made = keyedBatch(TWO_NOTES, {
    ok: false,
    error: "DESTINATION_EXISTS",
    message: "Something already exists at 2-areas/b.md.",
  });

  const answer = await toolMoveNotes(made.store, "private", [], new Map(), TWO_MOVES, false);

  assert.match(answer.content[0].text, /^conflict: Something already exists at 2-areas\/b\.md/);
  assert.equal(made.batches.length, 1);
  assert.deepEqual(noteWrites(made.writes), []);
});

test("a keyed batch that cannot reach the control plane is refused, and no note moves", async () => {
  const made = keyedBatch(TWO_NOTES, new Error("network"));

  const answer = await toolMoveNotes(made.store, "private", [], new Map(), TWO_MOVES, false);

  assert.match(answer.content[0].text, /could not start the moves right now/);
  assert.deepEqual(noteWrites(made.writes), []);
});

test("a keyed batch still needs each note's version, and asks nothing without it", async () => {
  const made = keyedBatch(TWO_NOTES, { ok: true, moves: [] });
  const unversioned = [{ source: "1-projects/a.md", destination: "2-areas/a.md" }];

  const answer = await toolMoveNotes(made.store, "private", [], new Map(), unversioned, false);

  assert.match(answer.content[0].text, /expected_source_etag is required/);
  assert.deepEqual(made.batches, []);
});

test("a keyed batch's dry run still plans without asking the control plane", async () => {
  const made = keyedBatch(TWO_NOTES, { ok: true, moves: [] });

  const planned = await toolMoveNotes(made.store, "private", [], new Map(), TWO_MOVES, true);

  assert.match(planned.content[0].text, /preflight ok: 2 moves/);
  assert.deepEqual(made.batches, []);
});

test("a keyed folder reports the move without the copy that storage has not done", async () => {
  const made = keyed({ "1-projects/a/x.md": { body: "x", etag: "e1" } }, { queued: true, count: 1, rowed: true });

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), "1-projects/a", "2-areas/a", false);

  assert.match(answer.content[0].text, /moved folder: 1-projects\/a\/ → 2-areas\/a\/ \(1 objects\)/);
  assert.doesNotMatch(answer.content[0].text, /storage finishes copying/);
});
