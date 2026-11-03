/**
 * `trash_note` (`src/tools/moves/trash.js`, owner 2026-11-03): an AI client moves a note or folder to the
 * workspace's Trash, restorable for 30 days, the app's Delete. Proven here:
 *
 *  1. The object is asked with the caller's identity from `store.objectReading`, never from the arguments, and an
 *     etag only when one was given; the answer says it is in the Trash and how long it can come back.
 *  2. A workspace not served by its object, a caller that is not this session, and a read-only reading trash
 *     nothing and say to archive instead; nothing reaches any object.
 *  3. Refusals are worded as the other moves word them; `HIDDEN` is "not found", like a note that is not there.
 *  4. A path into the plumbing (`.context/…`, the Trash itself) is refused before anything is asked.
 *  5. A trash committed with the mirror behind (`MIRROR_PENDING`) is reported as done, never "try again".
 *  6. Through the worker, a `manage` `trash` call from a read-only grant is refused by the write gate
 *     (`bulkNotes.test.mjs`).
 *
 * Sabotage, each confirmed to fail a case here (2026-11-03): send the arguments' scope instead of the reading's
 * (2); drop the `canWrite` check (2); word `HIDDEN` as "hidden" (3); drop the plumbing check (4); treat
 * `MIRROR_PENDING` as a failure (5).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolTrashNote } from "../src/tools/moves/trash.js";

function objectStore(answer, overrides = {}) {
  const sent = [];
  const kept = new Map();
  const store = {
    // The bookkeeping `recordChange` keeps (audit, activity): a bucket that holds what it is given.
    async get(key) {
      const body = kept.get(key);
      return body === undefined ? null : { etag: "k", text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
    async put(key, body) {
      kept.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      return { etag: "k" };
    },
    async delete(key) {
      kept.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...kept.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    objectReading: {
      client: {
        write: {
          trash: async (body) => {
            sent.push(body);
            if (answer instanceof Error) throw answer;
            return answer;
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
      log: () => {},
      ...overrides,
    },
  };
  return { store, sent };
}

const textOf = (result) => result.content[0].text;

test("the object trashes with the session's identity, and the answer says it can come back", async () => {
  const { store, sent } = objectStore({ ok: true, to: ".context/trash/s1/a/x.md", count: 1, at: 1 });
  const result = await toolTrashNote(store, "team", "a/x.md", undefined);
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /^trashed: a\/x\.md\n/);
  assert.match(textOf(result), /restored from the app for 30 days/);
  assert.deepEqual(sent, [{ path: "a/x.md", scope: "team", groups: ["g1"], userId: "u1" }]);

  const folder = objectStore({ ok: true, to: ".context/trash/s1/a", count: 4, at: 1 });
  assert.match(textOf(await toolTrashNote(folder.store, "team", "a", "e1")), /^trashed: a \(4 notes\)/);
  assert.equal(folder.sent[0].expectedEtag, "e1");
});

test("no object, another caller, or a read-only reading trashes nothing and says to archive", async () => {
  for (const overrides of [{ home: "bucket" }, { behind: true }, { client: null }, { canWrite: false }, { scope: "private" }]) {
    const { store, sent } = objectStore({ ok: true, count: 1 }, overrides);
    const result = await toolTrashNote(store, "team", "a/x.md", undefined);
    assert.equal(result.isError, true, JSON.stringify(overrides));
    assert.match(textOf(result), /Archive the note instead/);
    assert.equal(sent.length, 0, JSON.stringify(overrides));
  }
  const bare = await toolTrashNote({}, "team", "a/x.md", undefined);
  assert.match(textOf(bare), /Archive the note instead/);
});

test("refusals are worded as the other moves word them", async () => {
  for (const [code, words] of [
    ["NOT_FOUND", "not found"],
    ["HIDDEN", "not found"],
    ["CHANGED", "conflict: the note changed since you read it; re-read and retry"],
    ["BUILT_IN_ARCHIVED", "that folder stays where it is"],
  ]) {
    const { store } = objectStore({ ok: false, code });
    const result = await toolTrashNote(store, "team", "a/x.md", undefined);
    assert.equal(result.isError, true);
    assert.equal(textOf(result), words, code);
  }
  const thrown = objectStore(new Error("a/x.md exploded"));
  const result = await toolTrashNote(thrown.store, "team", "a/x.md", undefined);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /nothing was moved/);
});

test("the plumbing is never a path to trash", async () => {
  for (const path of [".context/trash/s1/a/x.md", ".context/collaboration/x", "", "../x.md"]) {
    const { store, sent } = objectStore({ ok: true, count: 1 });
    const result = await toolTrashNote(store, "team", path, undefined);
    assert.equal(result.isError, true, path);
    assert.equal(sent.length, 0, path);
  }
});

test("a trash the object committed with the mirror behind is done", async () => {
  const { store } = objectStore({ ok: false, code: "MIRROR_PENDING", answer: { ok: true, to: ".context/trash/s1/a/x.md", count: 1 } });
  const result = await toolTrashNote(store, "team", "a/x.md", undefined);
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /^trashed: a\/x\.md/);
});
