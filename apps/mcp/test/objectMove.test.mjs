/**
 * `startObjectMove` (`src/tools/moves/objectMove.js`): an AI client's move made in the workspace's object for a
 * workspace whose notes live there. Proven here: the object is asked with the caller's identity from
 * `store.objectReading` (never from the arguments), no expected etag is sent when none was given, each refusal
 * code is worded as an error, every "leave it to the control plane" case returns null without moving, a folder
 * move is worded with its object count, and the forwarding ledger and folder icons follow behind the answer
 * (awaited when the host gives no `defer`). The two callers in `queuedFolder.js` take the object's answer when it
 * has one and fall through to the control plane (`startQueuedMove`) only on `DEFER`.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the check that the caller's scope is this session's, or the `canWrite` check, and a fallback case fails;
 *  - send no groups, and the identity case fails;
 *  - word `HIDDEN` as anything but "not found", and the refusal case fails;
 *  - answer `DEFER` with an error, and the fallback and keyed-caller cases fail;
 *  - drop the forwarding record, and the behind-the-answer cases fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startObjectMove } from "../src/tools/moves/objectMove.js";
import { startKeyedNoteMove, startQueuedFolderMove } from "../src/tools/moves/queuedFolder.js";

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

const PRIVACY = { rules: [], overrides: new Map() };

/**
 * A store whose object answers `answer` to every move, with each body it was sent recorded in `sent`. The control
 * plane's `startQueuedMove` is replaced with a recorder so a test can see whether it was asked.
 */
function objectStore(answer) {
  const { store } = memory();
  const sent = [];
  const queued = [];
  const logged = [];
  store.objectReading = {
    client: {
      write: {
        move: async (body) => {
          sent.push(body);
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(body) : answer;
        },
      },
    },
    home: "object",
    behind: false,
    canWrite: true,
    scope: "team",
    names: new Set(["g1"]),
    userId: "u1",
    workspaceId: "w1",
    log: (event, fields) => logged.push({ event, fields }),
  };
  store.keyedLayout = true;
  store.startQueuedMove = async (from, to, etag) => {
    queued.push([from, to, etag]);
    return { queued: true, rowed: true, count: 1 };
  };
  return { store, sent, queued, logged };
}

const NOTE = { kind: "note", action: "move_note", privacy: PRIVACY };
const FOLDER = { kind: "folder", action: "move_folder", privacy: PRIVACY };

test("an ok answer moves the note: a text reply, the caller's identity, no etag, and no control plane", async () => {
  const { store, sent, queued } = objectStore({ ok: true, from: "a/x.md", to: "b/x.md", count: 1, at: 1, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.notEqual(result, null);
  assert.notEqual(result.isError, true);
  assert.ok(result.content[0].text.startsWith("moved note: a/x.md → b/x.md"), result.content[0].text);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "a/x.md");
  assert.equal(sent[0].to, "b/x.md");
  assert.equal(sent[0].scope, "team");
  assert.deepEqual(sent[0].groups, ["g1"]);
  assert.equal(sent[0].userId, "u1");
  assert.equal("expectedEtag" in sent[0], false);
  assert.deepEqual(queued, []);
});

test("an expected etag is passed through in the body", async () => {
  const { store, sent } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", "e1", NOTE);
  assert.notEqual(result.isError, true);
  assert.equal(sent[0].expectedEtag, "e1");
});

test("identity comes from the object reading, not from the arguments", async () => {
  const { store, sent } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  // The arguments name a different scope than the one the reading resolved, so the reading's scope must match it
  // and the body carries the reading's own groups and user.
  store.objectReading.names = ["g9", "g7"];
  store.objectReading.userId = "u-session";
  await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, { ...NOTE, userId: "u-spoof", groups: ["admin"], scope: "private" });
  assert.equal(sent[0].scope, "team");
  assert.deepEqual(sent[0].groups, ["g9", "g7"]);
  assert.equal(sent[0].userId, "u-session");
});

test("NOT_FOUND is an error worded 'not found'", async () => {
  const { store } = objectStore({ ok: false, code: "NOT_FOUND" });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "not found");
});

test("HIDDEN is an error worded 'not found', exactly like NOT_FOUND", async () => {
  const { store } = objectStore({ ok: false, code: "HIDDEN" });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "not found");
});

test("CHANGED is an error worded as a conflict", async () => {
  const { store } = objectStore({ ok: false, code: "CHANGED" });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", "e1", NOTE);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith("conflict:"), result.content[0].text);
});

test("TAKEN is an error worded 'conflict: destination already exists'", async () => {
  const { store } = objectStore({ ok: false, code: "TAKEN" });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "conflict: destination already exists");
});

test("INVALID is an error worded 'invalid path'", async () => {
  const { store } = objectStore({ ok: false, code: "INVALID" });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "invalid path");
});

test("ARCHIVE_STAYS is an error worded 'that folder stays where it is'", async () => {
  const { store } = objectStore({ ok: false, code: "ARCHIVE_STAYS" });
  const result = await startObjectMove(store, "team", "a", "b", undefined, FOLDER);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "that folder stays where it is");
});

test("DEFER falls back to the control plane (null, nothing moved here)", async () => {
  const { store, sent } = objectStore({ ok: false, code: "DEFER" });
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 1);
});

test("UNKEYED falls back to the control plane (null)", async () => {
  const { store } = objectStore({ ok: false, code: "UNKEYED" });
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
});

test("NOT_READY falls back to the control plane (null)", async () => {
  const { store } = objectStore({ ok: false, code: "NOT_READY" });
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
});

test("a write.move that throws falls back (null) and logs only the error class", async () => {
  const error = new TypeError("boom with a/secret.md in it");
  const { store, logged } = objectStore(error);
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "workspace_object_move_failed");
  assert.equal(logged[0].fields.error, "TypeError");
  assert.equal(JSON.stringify(logged[0].fields).includes("secret"), false);
});

test("a home other than object falls back (null) without asking the object", async () => {
  const { store, sent } = objectStore({ ok: true, files: [] });
  store.objectReading.home = "bucket";
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 0);
});

test("a workspace still behind falls back (null) without asking the object", async () => {
  const { store, sent } = objectStore({ ok: true, files: [] });
  store.objectReading.behind = true;
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 0);
});

test("a read-only caller falls back (null) without asking the object", async () => {
  const { store, sent } = objectStore({ ok: true, files: [] });
  store.objectReading.canWrite = false;
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 0);
});

test("no object reading at all falls back (null)", async () => {
  const { store, sent } = objectStore({ ok: true, files: [] });
  delete store.objectReading;
  assert.equal(await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 0);
});

test("a scope argument that differs from the reading's scope falls back and never calls write.move", async () => {
  const { store, sent } = objectStore({ ok: true, files: [] });
  assert.equal(await startObjectMove(store, "private", "a/x.md", "b/x.md", undefined, NOTE), null);
  assert.equal(sent.length, 0);
});

test("a folder move is worded with its object count", async () => {
  const files = [
    { from: "a/1.md", to: "b/1.md" },
    { from: "a/2.md", to: "b/2.md" },
    { from: "a/sub/3.md", to: "b/sub/3.md" },
  ];
  const { store } = objectStore({ ok: true, files });
  const result = await startObjectMove(store, "team", "a", "b", undefined, FOLDER);
  assert.notEqual(result.isError, true);
  assert.ok(result.content[0].text.startsWith("moved folder: a/ → b/ (3 objects)"), result.content[0].text);
});

test("forwarding and icons run behind the answer through store.defer, and are awaited through it", async () => {
  const { store } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const deferred = [];
  store.defer = (promise) => deferred.push(promise);
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.notEqual(result.isError, true);
  // recordChange also defers its own bookkeeping (audit, activity, tree announcements), so the count is not 1; the
  // forwarding work is one of them, and it is awaited here with the rest.
  assert.ok(deferred.length >= 1, "the move hands its work to store.defer");
  await Promise.all(deferred);
  const forwarding = await store.get(".context/forwarding.json");
  assert.notEqual(forwarding, null);
  assert.ok((await forwarding.text()).includes("a/x.md"));
});

test("without store.defer the forwarding file exists as soon as the call returns", async () => {
  const { store } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  assert.equal(typeof store.defer, "undefined");
  await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  const forwarding = await store.get(".context/forwarding.json");
  assert.notEqual(forwarding, null);
  assert.ok((await forwarding.text()).includes("a/x.md"));
});

test("startKeyedNoteMove takes an ok object answer and never asks the control plane", async () => {
  const { store, queued } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const result = await startKeyedNoteMove(store, "team", "a/x.md", "b/x.md", undefined, PRIVACY);
  assert.notEqual(result.isError, true);
  assert.ok(result.content[0].text.startsWith("moved note: a/x.md → b/x.md"), result.content[0].text);
  assert.deepEqual(queued, []);
});

test("startKeyedNoteMove on DEFER asks the control plane once, with no etag", async () => {
  const { store, queued } = objectStore({ ok: false, code: "DEFER" });
  await startKeyedNoteMove(store, "team", "a/x.md", "b/x.md", undefined, PRIVACY);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], ["a/x.md", "b/x.md", undefined]);
});

test("startQueuedFolderMove takes an ok object answer and never asks the control plane", async () => {
  const { store, queued } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const result = await startQueuedFolderMove(store, "team", "a", "b", PRIVACY);
  assert.notEqual(result.isError, true);
  assert.ok(result.content[0].text.startsWith("moved folder: a/ → b/ (1 objects)"), result.content[0].text);
  assert.deepEqual(queued, []);
});

test("startQueuedFolderMove on DEFER asks the control plane once", async () => {
  const { store, queued } = objectStore({ ok: false, code: "DEFER" });
  await startQueuedFolderMove(store, "team", "a", "b", PRIVACY);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], ["a", "b", undefined]);
});
