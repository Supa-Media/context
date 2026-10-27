/**
 * A keyed move leaves a note's collaboration history where it is, filed by the
 * note's id (`docs/decisions/storage-and-credentials/paths-on-read.md`, "Editing
 * history is filed by note id"): the row moves, the bytes stay at their id key,
 * nothing under `.context/collaboration/` is written, the new name finds the
 * same document, and the old name's live room is told where the note went.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - file heads by path again (`headAddress` ignores the id): the moved note opens a new document;
 *  - put a `renameDocument` call back in `announceMoves`: the moves write collaboration state;
 *  - skip the presence notice: the old room is never told the note moved;
 *  - send the new name whatever the rules: the narrowing case names a private folder to the room.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readDocument } from "@context/collaboration";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { toolMoveFolder } from "../src/tools/moves/folder.js";
import { ANNOUNCE_MOVES_MAX } from "../src/moves/keyedCollaboration.js";

/**
 * A keyed workspace's bucket: notes at id keys, reached by path through rows,
 * with plumbing (`.context/…`) at its own keys. `startQueuedMove` makes the
 * row change the control plane makes, and copies nothing.
 */
function keyedRows(files) {
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
    // The id of the note at a name, as the id layer answers it (`store/idLayout.js`): its key's number.
    async noteIdAt(path) {
      const key = rows.get(path);
      return key === undefined ? null : `0190a000-0000-7000-8000-${key.replace(/\D/g, "").padStart(12, "0")}`;
    },
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
        if (rows.has(pair.to)) return { queued: false, error: "DESTINATION_EXISTS", message: "taken" };
        rows.set(pair.to, rows.get(pair.from));
        rows.delete(pair.from);
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

const collaborationWrites = (made) => made.writes.filter(([, key]) => key.startsWith(".context/collaboration/"));

test("a keyed note move writes no collaboration state, the new name opens the same history, and the old room is told", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } });
  const opened = await readDocument(made.store, "1-projects/a.md");
  made.writes.length = 0;

  const answer = await toolMoveNote(made.store, "private", TEAM_BOTH, new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.match(answer.content[0].text, /moved note: 1-projects\/a\.md → 2-areas\/a\.md/);
  assert.deepEqual(collaborationWrites(made), [], "the move carries nothing");
  const after = await readDocument(made.store, "2-areas/a.md");
  assert.equal(after.documentId, opened.documentId, "the note keeps its identity under the new name");
  assert.deepEqual(made.rooms.map((room) => [room.url, room.body]), [
    ["https://presence.invalid/moved", { to: "2-areas/a.md" }],
  ]);
  assert.ok(made.rooms[0].name.includes("1-projects%2Fa.md"), "the notice goes to the room the old name had");
});

test("a move that narrows the note does not tell the old room where it went, but still closes its members", async () => {
  const made = keyedRows({ "1-projects/a.md": { body: "# A\n", etag: "e0" } });
  await readDocument(made.store, "1-projects/a.md");
  // The old folder is team-visible; the new one is private to its owners, so team members must not learn the new name.
  const narrowing = [{ prefix: "1-projects", vis: "team" }, { prefix: "2-areas", vis: "private" }];

  await toolMoveNote(made.store, "private", narrowing, new Map(), "1-projects/a.md", "2-areas/a.md");

  assert.deepEqual(made.rooms.map((room) => room.body), [{ to: null }]);
});

test("a folder move writes no collaboration state, every note keeps its history, and each old room is told", async () => {
  const made = keyedRows({
    "1-projects/launch/has.md": { body: "# Has\n", etag: "e1" },
    "1-projects/launch/plain.md": { body: "# Plain\n", etag: "e2" },
  });
  const had = await readDocument(made.store, "1-projects/launch/has.md");
  made.writes.length = 0;

  const rules = [{ prefix: "1-projects", vis: "team" }, { prefix: "3-resources", vis: "team" }];
  const answer = await toolMoveFolder(made.store, "private", rules, new Map(), "1-projects/launch", "3-resources/launch", false);

  assert.match(answer.content[0].text, /moved folder: 1-projects\/launch\//);
  assert.deepEqual(collaborationWrites(made), []);
  assert.equal((await readDocument(made.store, "3-resources/launch/has.md")).documentId, had.documentId);
  assert.deepEqual(made.rooms.map((room) => room.body).sort((a, b) => a.to.localeCompare(b.to)), [
    { to: "3-resources/launch/has.md" },
    { to: "3-resources/launch/plain.md" },
  ]);
});

test("a move of more notes than are announced tells no room, and still carries nothing", async () => {
  const files = Object.fromEntries(Array.from({ length: ANNOUNCE_MOVES_MAX + 1 }, (_, n) => [`1-projects/big/n${n}.md`, { body: `# N${n}\n`, etag: `e${n}` }]));
  const made = keyedRows(files);
  const opened = await readDocument(made.store, "1-projects/big/n0.md");
  made.writes.length = 0;

  await toolMoveFolder(made.store, "private", TEAM_BOTH, new Map(), "1-projects/big", "2-areas/big", false);

  assert.deepEqual(made.rooms, []);
  assert.deepEqual(collaborationWrites(made), []);
  assert.equal((await readDocument(made.store, "2-areas/big/n0.md")).documentId, opened.documentId);
});
