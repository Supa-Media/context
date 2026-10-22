/**
 * A keyed move carries the note's collaboration history to its new name
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`, "Moves in a keyed
 * workspace are row changes"): the row moves, the bytes stay at their id key,
 * the engine's heads and state follow the name, and the old name's live room
 * is told where the note went.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `renameCollaboration` call in `startKeyedNoteMove` and the open
 *    editor's identity is left at the old name (the first case fails);
 *  - rename every note in a folder, history or not, and the no-history case writes collaboration state;
 *  - let a failed rename fail the row move, and the refused-name case reports a failure;
 *  - skip the presence notice and the old room is never told the note moved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitUpdate, readDocument, renameDocument } from "@context/collaboration";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { toolMoveFolder } from "../src/tools/moves/folder.js";

/**
 * A keyed workspace's bucket: notes at id keys, reached by path through rows,
 * with plumbing (`.context/…`) at its own keys. `startQueuedMove` makes the
 * row change the control plane makes, and copies nothing.
 */
function keyedRows(files, { overwriteRows = false, controlPlaneCarries = false } = {}) {
  const rows = new Map();
  const objects = new Map();
  const writes = [];
  const rooms = [];
  let counter = 0;
  for (const [path, { body, etag }] of Object.entries(files)) {
    const key = `notes/${++counter}.md`;
    rows.set(path, key);
    objects.set(key, { body, etag });
  }
  const physical = (path) => (path.startsWith(".context/") ? path : (rows.get(path) ?? null));
  const versionOf = (path) => {
    const key = physical(path);
    return key === null ? undefined : objects.get(key);
  };
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    keyedLayout: true,
    actor: { workspaceId: "ws-1" },
    presenceRooms: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (url, init) => {
          rooms.push({ name, url, body: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    },
    async head(path) {
      const value = versionOf(path);
      return value === undefined ? null : { etag: value.etag, size: value.body.length };
    },
    async exists(path) {
      return versionOf(path) !== undefined;
    },
    async existsMetadata(path) {
      return versionOf(path) !== undefined;
    },
    async get(path) {
      const value = versionOf(path);
      if (value === undefined) return null;
      return {
        etag: value.etag,
        httpMetadata: {},
        text: async () => value.body,
        arrayBuffer: async () => new TextEncoder().encode(value.body).buffer,
      };
    },
    async put(path, body, options = {}) {
      writes.push(["put", path]);
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      let key = physical(path);
      if (key === null) {
        key = `notes/${++counter}.md`;
        rows.set(path, key);
      }
      const current = objects.get(key);
      if (options.onlyIf?.absent && current) return null;
      if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
      const etag = `e${++counter}`;
      objects.set(key, { body: text, etag });
      return { etag };
    },
    async delete(path, options = {}) {
      writes.push(["delete", path]);
      const key = physical(path);
      const current = key === null ? undefined : objects.get(key);
      if (!current) return;
      if (options.onlyIf?.etagMatches !== undefined && current.etag !== options.onlyIf.etagMatches) return null;
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key, etag: objects.get(key).etag })),
        truncated: false,
      };
    },
    async startQueuedMove(from, to) {
      const moved = [];
      for (const path of rows.keys()) {
        if (path === from || path.startsWith(`${from}/`)) moved.push({ from: path, to: `${to}${path.slice(from.length)}` });
      }
      if (moved.length === 0) return { queued: false };
      for (const pair of moved) {
        if (!overwriteRows && rows.has(pair.to)) return { queued: false, error: "DESTINATION_EXISTS", message: "taken" };
        rows.set(pair.to, rows.get(pair.from));
        rows.delete(pair.from);
      }
      if (controlPlaneCarries) {
        // The control plane carries each note's history with its row (`nodes/rowHistory.ts`) and says so.
        for (const pair of moved) await renameDocument(store, pair.from, pair.to, { internalTrash: true }).catch(() => {});
        return { queued: true, count: moved.length, rowed: true, historyCarried: true, moved };
      }
      return { queued: true, count: moved.length, rowed: true, moved };
    },
  };
  return { store, objects, writes, rooms, rows };
}

const TEAM_BOTH = [
  { prefix: "1-projects", vis: "team" },
  { prefix: "2-areas", vis: "team" },
];

test("a keyed note move carries its collaboration history to the new name, and the old room is told", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } });
  const opened = await readDocument(made.store, "1-projects/a.md");

  const answer = await toolMoveNote(made.store, "private", TEAM_BOTH, new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.match(answer.content[0].text, /moved note: 1-projects\/a\.md → 2-areas\/a\.md/);
  const after = await readDocument(made.store, "2-areas/a.md");
  assert.equal(after.documentId, opened.documentId, "the note keeps its identity under the new name");
  await assert.rejects(() => readDocument(made.store, "1-projects/a.md"), (error) => error.code === "MOVED" && error.destination === "2-areas/a.md");
  assert.deepEqual(made.rooms.map((room) => [room.url, room.body]), [
    ["https://presence.invalid/moved", { to: "2-areas/a.md" }],
  ]);
  assert.ok(made.rooms[0].name.includes("1-projects%2Fa.md"), "the notice goes to the room the old name had");
});

test("history the control plane already carried is not renamed again, and the old room is still told", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } }, { controlPlaneCarries: true });
  const opened = await readDocument(made.store, "1-projects/a.md");

  await toolMoveNote(made.store, "private", TEAM_BOTH, new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.equal((await readDocument(made.store, "2-areas/a.md")).documentId, opened.documentId);
  assert.deepEqual(made.rooms.map((room) => room.body), [{ to: "2-areas/a.md" }]);
});

test("a move that narrows the note does not tell the old room where it went, but still closes its members", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } });
  await readDocument(made.store, "1-projects/a.md");
  // The old folder is team-visible; the new one is private to its owners, so team members must not learn the new name.
  const narrowing = [{ prefix: "1-projects", vis: "team" }, { prefix: "2-areas", vis: "private" }];

  await toolMoveNote(made.store, "private", narrowing, new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.deepEqual(made.rooms.map((room) => room.body), [{ to: null }]);
});

test("a note with no collaboration history moves without writing any collaboration state", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } });

  await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md");

  // The activity record is written under `.context/audit/`; collaboration state is what must not be written.
  assert.deepEqual(made.writes.filter(([, key]) => key.startsWith(".context/collaboration/")), []);
  assert.deepEqual(made.rooms, []);
});

test("a rename refused by another document's name leaves the row move standing and the old history where it was", async () => {
  const made = keyedRows({
    "2-areas/a.md": { body: "# Theirs\n", etag: "e1" },
    "1-projects/a.md": { body: "# Mine\n", etag: "e2" },
  }, { overwriteRows: true });
  const mine = await readDocument(made.store, "1-projects/a.md");
  const theirs = await readDocument(made.store, "2-areas/a.md");

  const answer = await toolMoveNote(made.store, "private", [], new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.match(answer.content[0].text, /moved note: /, "the row move is what the control plane did, and it stands");
  assert.notEqual(mine.documentId, theirs.documentId);
  assert.deepEqual(made.rooms, [], "nothing moved in the engine, so no room is told");
  const state = JSON.parse(made.objects.get(`.context/collaboration/v1/documents/${mine.documentId}.json`).body);
  assert.equal(state.path, "1-projects/a.md");
  assert.equal(state.structural, null);
});

test("a folder move renames the history of the notes that have it, and no others", async () => {
  const made = keyedRows({
    "1-projects/launch/has.md": { body: "# Has\n", etag: "e1" },
    "1-projects/launch/plain.md": { body: "# Plain\n", etag: "e2" },
  });
  const had = await readDocument(made.store, "1-projects/launch/has.md");

  const rules = [{ prefix: "1-projects", vis: "team" }, { prefix: "3-resources", vis: "team" }];
  const answer = await toolMoveFolder(made.store, "private", rules, new Map(), "1-projects/launch", "3-resources/launch", false);

  assert.match(answer.content[0].text, /moved folder: 1-projects\/launch\//);
  const carried = await readDocument(made.store, "3-resources/launch/has.md");
  assert.equal(carried.documentId, had.documentId);
  // Only the note with history has collaboration heads: its old fence and its new head. The plain note has none.
  const heads = [...made.objects.keys()].filter((key) => key.startsWith(".context/collaboration/v1/heads/"));
  assert.equal(heads.length, 2);
  assert.deepEqual(made.rooms.map((room) => room.body), [{ to: "3-resources/launch/has.md" }]);
  await assert.rejects(
    () => commitUpdate(made.store, "1-projects/launch/has.md", { documentId: had.documentId, update: had.update }),
    (error) => error.code === "MOVED",
  );
});
