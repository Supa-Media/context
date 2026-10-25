/**
 * A note's editing history is filed by its note id (decided by the owner,
 * 2026-10-25; `notes-by-id.md`, "Editing history is filed by note id"), so a
 * move carries nothing. An editor that typed at the old name before it heard
 * of the move sends its update there with its document id; the route finds
 * that document's note where it is now and commits there, judged by the same
 * rules as the old name.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the note-id forward in `collaborationRoute.js` and the offline update after a move is a 404;
 *  - skip `canSee` on the found name and the narrowed case commits into a folder the member cannot see.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { readDocument } from "@context/collaboration";
import { handleCollaboration } from "../src/live/collaborationRoute.js";
import { PRE_PARSED_RULES, PRIVACY_KEY, PrivacyOverrides } from "../src/privacy/engine.js";

const NOTE = "0190a000-0000-7000-8000-0000000000c1";

/** A keyed workspace's store as the route sees it: notes at id keys, reached by name through rows. */
function keyedStore(rules) {
  const objects = new Map();
  const rows = new Map();
  let sequence = 0;
  const physical = (key) => (key.startsWith(".context/") ? key : (rows.get(key)?.key ?? null));
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    rows,
    objects,
    async get(key) {
      if (key === PRIVACY_KEY) return { etag: "rules", [PRE_PARSED_RULES]: { rules, overrides: new PrivacyOverrides() } };
      const at = physical(key);
      const object = at === null ? undefined : objects.get(at);
      return object ? { etag: object.etag, text: async () => object.text, body: object.text } : null;
    },
    async head(key) {
      const at = physical(key);
      const object = at === null ? undefined : objects.get(at);
      return object ? { etag: object.etag, size: object.text.length } : null;
    },
    async exists(key) {
      return (await this.head(key)) !== null;
    },
    async existsMetadata(key) {
      return (await this.head(key)) !== null;
    },
    async put(key, value, options = {}) {
      const at = physical(key);
      if (at === null) return null;
      const current = objects.get(at);
      if (options.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.absent && current) return null;
      const etag = `e${++sequence}`;
      objects.set(at, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
      return { etag };
    },
    async delete(key) {
      const at = physical(key);
      if (at !== null) objects.delete(at);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: objects.get(key).etag })), truncated: false };
    },
    async noteIdAt(path) {
      return rows.get(path)?.noteId ?? null;
    },
    async pathOfNoteId(noteId) {
      for (const [path, row] of rows) if (row.noteId === noteId) return path;
      return null;
    },
  };
  return store;
}

function seed(store, path, text) {
  const key = `notes/${NOTE}.md`;
  store.rows.set(path, { key, noteId: NOTE });
  store.objects.set(key, { etag: "e0", text });
}

function move(store, from, to) {
  store.rows.set(to, store.rows.get(from));
  store.rows.delete(from);
}

function editOf(snapshot, text) {
  const base = new Y.Doc({ gc: false });
  Y.applyUpdate(base, Buffer.from(snapshot, "base64"));
  const since = Y.encodeStateVector(base);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const note = doc.getText("note");
  note.delete(0, note.length);
  note.insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc, since)).toString("base64");
}

const session = (scope) => ({ scope, scopes: ["context:read", "context:write"], grantedGroups: new Set() });

function post(store, who, body) {
  const request = new Request("https://gateway.invalid/collaboration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return handleCollaboration(request, store, who, "https://gateway.invalid");
}

test("an update sent to a note's old name after a move lands on the moved note, with its history", async () => {
  const store = keyedStore([{ prefix: "team", vis: "team" }]);
  seed(store, "team/plan.md", "# Plan\n\nOne.\n");
  const opened = await readDocument(store, "team/plan.md");
  move(store, "team/plan.md", "team/archive/plan.md");

  const response = await post(store, session("team"), { path: "team/plan.md", documentId: opened.documentId, update: editOf(opened.update, "# Plan\n\nTwo.\n") });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.documentId, opened.documentId);
  assert.equal(body.text, "# Plan\n\nTwo.\n");
  assert.equal(store.objects.get(`notes/${NOTE}.md`).text, "# Plan\n\nTwo.\n");
});

test("a note moved where the member cannot see it is not reached through its old name", async () => {
  const store = keyedStore([{ prefix: "team", vis: "team" }, { prefix: "team/secret", vis: "private" }]);
  seed(store, "team/plan.md", "# Plan\n\nOne.\n");
  const opened = await readDocument(store, "team/plan.md");
  move(store, "team/plan.md", "team/secret/plan.md");

  const response = await post(store, session("team"), { path: "team/plan.md", documentId: opened.documentId, update: editOf(opened.update, "# Plan\n\nLeak.\n") });

  assert.equal(response.status, 404);
  assert.equal(store.objects.get(`notes/${NOTE}.md`).text, "# Plan\n\nOne.\n");
});

test("a plain read of a name a note moved away from finds nothing there", async () => {
  const store = keyedStore([{ prefix: "team", vis: "team" }]);
  seed(store, "team/plan.md", "# Plan\n\nOne.\n");
  await readDocument(store, "team/plan.md");
  move(store, "team/plan.md", "team/archive/plan.md");

  const response = await post(store, session("team"), { path: "team/plan.md" });

  assert.equal(response.status, 404);
});
