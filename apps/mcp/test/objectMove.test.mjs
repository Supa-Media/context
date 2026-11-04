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
import { toolArchiveNote } from "../src/tools/moves/archive.js";
import { ControlPlaneError } from "../src/controlPlane/client.js";
import { toolMoveKeyedFolder } from "../src/tools/moves/keyedFolder.js";
import { withServedTree } from "./servedTree.mjs";

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

test("a control-plane move the gateway stopped waiting on is answered as one that may still finish, not as a failure", async () => {
  const { store } = objectStore({ ok: false, code: "DEFER" });
  store.startQueuedMove = async () => {
    throw new ControlPlaneError("timed out");
  };
  const result = await startKeyedNoteMove(store, "team", "a/x.md", "b/x.md", undefined, PRIVACY);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /may still finish; check whether b\/x\.md exists/);
  store.startQueuedMove = async () => {
    throw new ControlPlaneError("request failed");
  };
  const failed = await startKeyedNoteMove(store, "team", "a/x.md", "b/x.md", undefined, PRIVACY);
  assert.match(failed.content[0].text, /could not start the move right now/);
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

/* -- archive_note through the object (`toolArchiveNote` on an object-served workspace) ------------------------------ */

const ARCHIVE_RULES = [
  { prefix: "1-projects", vis: "team" },
  { prefix: "4-archive", vis: "team" },
];

/** An object-served store holding `notes`, with every get recorded in `gets`. */
async function archiveStore(answer, notes = { "1-projects/a.md": "# A\n" }) {
  const made = objectStore(answer);
  for (const [key, body] of Object.entries(notes)) await made.store.put(key, body);
  const gets = [];
  const realGet = made.store.get;
  made.store.get = async (key, ...rest) => {
    gets.push(key);
    return realGet.call(made.store, key, ...rest);
  };
  return { ...made, gets };
}

test("archive through the object: an ok answer archives at the archive root, with no body read and no control plane", async () => {
  const { store, sent, queued, gets } = await archiveStore({
    ok: true,
    to: "4-archive/1-projects/a.md",
    files: [{ from: "1-projects/a.md", to: "4-archive/1-projects/a.md" }],
  });
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.ok(
    result.content[0].text.startsWith("archived: 1-projects/a.md → 4-archive/1-projects/a.md"),
    result.content[0].text
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "1-projects/a.md");
  // The object names the destination: the gateway sends the rules' archive, never a path of its own.
  assert.equal(sent[0].to, undefined);
  assert.deepEqual(sent[0].archive, { root: "4-archive", roots: ["4-archive"] });
  assert.equal(sent[0].expectedEtag, "e1");
  assert.deepEqual(queued, []);
  assert.equal(gets.includes("1-projects/a.md"), false, `the body was read: ${JSON.stringify(gets)}`);
});

test("archive through the object: the object's own numbered name is the answer's, and TAKEN after every name is the archive's conflict", async () => {
  const named = await archiveStore({ ok: true, to: "4-archive/1-projects/a (2).md", files: [{ from: "1-projects/a.md", to: "4-archive/1-projects/a (2).md" }] });
  const result = await toolArchiveNote(named.store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.ok(result.content[0].text.startsWith("archived: 1-projects/a.md → 4-archive/1-projects/a (2).md"), result.content[0].text);
  assert.equal(named.sent.length, 1);
  const full = await archiveStore({ ok: false, code: "TAKEN" });
  const refused = await toolArchiveNote(full.store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.equal(refused.content[0].text, "conflict: archive destination already exists");
  assert.equal(full.sent.length, 1);
  assert.deepEqual(full.queued, []);
});

test("archive through the object: the object's NO_ARCHIVE, ARCHIVED and HIDDEN_DESTINATION are worded as the gateway words them", async () => {
  for (const [code, words] of [["NO_ARCHIVE", /no archive folder/], ["ARCHIVED", /^already archived$/], ["HIDDEN_DESTINATION", /archive destination/]]) {
    const { store, sent, queued } = await archiveStore({ ok: false, code });
    const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
    assert.match(result.content[0].text, words, code);
    assert.equal(sent.length, 1, code);
    assert.deepEqual(queued, [], code);
  }
});

test("archive through the object: NOT_FOUND is answered as not found, one move sent, no control plane", async () => {
  const { store, sent, queued } = await archiveStore({ ok: false, code: "NOT_FOUND" });
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "not found");
  assert.equal(sent.length, 1);
  assert.deepEqual(queued, []);
});

test("archive through the object: DEFER falls through to the control plane, which is asked once, and the object once", async () => {
  const { store, sent, queued } = await archiveStore({ ok: false, code: "DEFER" });
  // The fall-through checks the destination against the tree's names (`destinationRefusal`), so the tree must answer.
  store.treeListing = { taken: async () => ({ files: [], folders: [] }) };
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.notEqual(result, undefined);
  assert.equal(queued.length, 1, JSON.stringify(result));
  assert.deepEqual(queued[0], ["1-projects/a.md", "4-archive/1-projects/a.md", "e1"]);
  // The fall-through does not ask the object the same move a second time (`objectAsked`).
  assert.equal(sent.length, 1);
});

test("archive through the object: a team archive without expected_etag is refused before the object is asked", async () => {
  const { store, sent, queued } = await archiveStore({ ok: true, files: [] });
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_etag/);
  assert.equal(sent.length, 0);
  assert.deepEqual(queued, []);
});

/** Records every probe of `key` (`objectExists` lists the key on this store). */
function probesOf(store, key) {
  const probes = [];
  const realList = store.list;
  store.list = async (options, ...rest) => {
    if (options?.prefix === key) probes.push(key);
    return realList.call(store, options, ...rest);
  };
  return probes;
}

test("archive through the object: the object's move says whether the note is there, so no probe goes first", async () => {
  const { store, sent } = await archiveStore({ ok: true, files: [{ from: "1-projects/a.md", to: "4-archive/1-projects/a.md" }] });
  const probes = probesOf(store, "1-projects/a.md");
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(probes, []);
  assert.equal(sent.length, 1);
});

test("archive through the object: a refusal before the move still says 'not found' for an absent note", async () => {
  const { store, sent } = await archiveStore({ ok: true, files: [] }, {});
  const probes = probesOf(store, "1-projects/gone.md");
  // A team archive without expected_etag is refused, but of a note that is not there the answer is "not found".
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/gone.md");
  assert.equal(result.content[0].text, "not found");
  assert.deepEqual(probes, ["1-projects/gone.md"]);
  assert.equal(sent.length, 0);
});

test("archive off the object: the archive folder's job is asked beside the probe, not after it", async () => {
  const { store } = memory();
  await store.put("1-projects/a.md", "# A\n");
  let probeAnswered = false;
  let askedBeforeProbeAnswered = false;
  const realList = store.list;
  store.list = async (options, ...rest) => {
    if (options?.prefix !== "1-projects/a.md") return realList.call(store, options, ...rest);
    // Long enough for a facts ask made beside the probe to arrive; one made after it arrives once this returns.
    await new Promise((resolve) => setTimeout(resolve, 20));
    probeAnswered = true;
    return realList.call(store, options, ...rest);
  };
  store.treeFacts = async ({ ask }) => {
    if (ask === "jobs" && !probeAnswered) askedBeforeProbeAnswered = true;
    return { served: true, jobs: { archive: "4-archive" }, roots: ["1-projects", "4-archive"] };
  };
  // Only the order of the two reads is asked here; the archive after them is the bucket's, tested elsewhere.
  await toolArchiveNote(store, "private", ARCHIVE_RULES, new Map(), "1-projects/a.md");
  assert.equal(probeAnswered, true);
  assert.equal(askedBeforeProbeAnswered, true, "the jobs were asked only after the probe answered");
});

test("archive through the object: a note this caller may not see asks no facts", async () => {
  const { store, sent } = await archiveStore({ ok: true, files: [] });
  let asked = 0;
  store.treeFacts = async () => {
    asked += 1;
    return { served: true, jobs: { archive: "4-archive" }, roots: [] };
  };
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "2-private/a.md", "e1");
  assert.equal(result.content[0].text, "not found");
  assert.equal(asked, 0);
  assert.equal(sent.length, 0);
});

test("archive through the object: a note already inside the archive is 'already archived', as the object answers it", async () => {
  const { store, sent, queued } = await archiveStore({ ok: false, code: "ARCHIVED" }, { "4-archive/x.md": "# X\n" });
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "4-archive/x.md", "e1");
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "already archived");
  assert.equal(sent.length, 1);
  assert.deepEqual(queued, []);
});


test("each step after the object's answer is timed on its own, so a slow move says where its time went", async () => {
  const { store } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  const timed = [];
  store.phase = (name, run) => {
    timed.push(name);
    return run();
  };
  await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  for (const name of ["move_announce", "move_record", "move_behind"]) assert.ok(timed.includes(name), `${name} in ${timed}`);
});

/* -- a folder's check left until the object passes the move on (`keyedFolder.js`'s full twin check) --------------- */

test("startQueuedFolderMove asks beforeControlPlane only on DEFER, and a refusal there asks the control plane nothing", async () => {
  const deferred = objectStore({ ok: false, code: "DEFER" });
  let asked = 0;
  const refused = await startQueuedFolderMove(deferred.store, "team", "a", "b", PRIVACY, {
    beforeControlPlane: async () => {
      asked += 1;
      return "Plans is already here";
    },
  });
  assert.equal(asked, 1);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Plans is already here/);
  assert.deepEqual(deferred.queued, []);

  const moved = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }] });
  asked = 0;
  const answer = await startQueuedFolderMove(moved.store, "team", "a", "b", PRIVACY, {
    beforeControlPlane: async () => {
      asked += 1;
      return "never";
    },
  });
  assert.notEqual(answer.isError, true);
  assert.equal(asked, 0);
  assert.deepEqual(moved.queued, []);
});

test("a keyed folder move the object makes lists only the top level for twins; one it defers is judged in full first", async () => {
  const rules = [{ prefix: "Projects", vis: "team" }, { prefix: "old", vis: "team" }];
  const seed = async (store) => {
    for (const key of ["Projects/Plans/Sub/a.md", "old/x.md"]) await store.put(key, "# x\n");
    withServedTree(store);
    const listed = [];
    const list = store.list.bind(store);
    store.list = async (options = {}) => {
      listed.push(options.prefix ?? "");
      return list(options);
    };
    return listed;
  };

  // Moved in the object: only the top level is looked at, never the destination's own folder ("Projects/Plans/").
  const moved = objectStore({ ok: true, files: [{ from: "old/x.md", to: "Projects/Plans/sub/x.md" }] });
  const listed = await seed(moved.store);
  const answer = await toolMoveKeyedFolder(moved.store, "team", rules, new Map(), "old", "Projects/Plans/sub", false);
  assert.notEqual(answer.isError, true, answer.content[0].text);
  assert.ok(!listed.includes("Projects/Plans/"), JSON.stringify(listed));

  // Deferred: the twin by case below the root is refused before the control plane is asked.
  const deferred = objectStore({ ok: false, code: "DEFER" });
  await seed(deferred.store);
  const refused = await toolMoveKeyedFolder(deferred.store, "team", rules, new Map(), "old", "Projects/Plans/sub", false);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Sub is already here/);
  assert.deepEqual(deferred.queued, []);
});

test("a keyed folder move the object makes inside one top-level folder lists nothing first; one it defers still does", async () => {
  const rules = [{ prefix: "archive", vis: "team" }];
  const seed = async (store) => {
    for (const key of ["archive/inbox/old/x.md", "archive/inbox/New/y.md"]) await store.put(key, "# x\n");
    withServedTree(store);
    const listed = [];
    const list = store.list.bind(store);
    store.list = async (options = {}) => {
      listed.push(options.prefix ?? "");
      return list(options);
    };
    return listed;
  };
  const moved = objectStore({ ok: true, files: [{ from: "archive/inbox/old/x.md", to: "archive/inbox/later/x.md" }] });
  const listed = await seed(moved.store);
  const answer = await toolMoveKeyedFolder(moved.store, "team", rules, new Map(), "archive/inbox/old", "archive/inbox/later", false);
  assert.notEqual(answer.isError, true, answer.content[0].text);
  assert.deepEqual(listed, []);

  const deferred = objectStore({ ok: false, code: "DEFER" });
  await seed(deferred.store);
  const refused = await toolMoveKeyedFolder(deferred.store, "team", rules, new Map(), "archive/inbox/old", "archive/inbox/new", false);
  assert.match(refused.content[0].text, /New is already here/);
  assert.deepEqual(deferred.queued, []);
});

test("an object move records the object's own time and its durable-write wait beside the call's trip", async () => {
  const { store } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }], took: 12, commit: 9 });
  const took = [];
  const timer = (name, run) => run();
  timer.took = (name, ms) => took.push([name, ms]);
  Object.defineProperty(store, "phase", { value: timer, enumerable: false });
  const result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(took, [["move", 12], ["move_commit", 9]]);
});

test("an object move records its trip outside the op: the wire both ways, each way, and a cold or busy object", async () => {
  const now = Date.now();
  // The object's clock ran 3 ms ahead of the gateway's: each way alone carries the skew, the two ways' sum does not.
  const answer = () => ({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }], took: 12, commit: 9, before: 2, arrived: now + 3, answered: now + 3 + 14, cold: true, alarm: true, alarmDuring: true });
  const { store } = objectStore(answer);
  const took = new Map();
  const timer = (name, run) => run();
  timer.took = (name, ms) => took.set(name, ms);
  Object.defineProperty(store, "phase", { value: timer, enumerable: false });
  const realNow = Date.now;
  // The gateway's clock: the send, then the answer 40 ms later.
  const clock = [now, now + 40];
  Date.now = () => (clock.length > 1 ? clock.shift() : clock[0]);
  let result;
  try {
    result = await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  } finally {
    Date.now = realNow;
  }
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(took.get("move_before"), 2);
  // 40 ms of trip, 14 of it the object's span: 26 on the wire, split 3 + 23 by the skewed clocks.
  assert.equal(took.get("move_legs"), 26);
  assert.equal(took.get("move_out"), 3);
  assert.equal(took.get("move_back"), 23);
  assert.equal(took.get("move_legs_cold"), 26);
  assert.equal(took.get("move_legs_alarm"), 26);
  assert.equal(took.get("move_legs_alarm_during"), 26);
  // The move found an alarm already due: its trip is counted as one that set none.
  assert.equal(took.get("move_legs_unarmed"), 26);
  assert.equal(took.has("move_legs_armed"), false);
});

test("a move that set the object's alarm says so beside its trip", async () => {
  const now = Date.now();
  const answer = () => ({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }], took: 12, commit: 9, before: 0, arrived: now, answered: now + 14, armed: true });
  const { store } = objectStore(answer);
  const took = new Map();
  const timer = (name, run) => run();
  timer.took = (name, ms) => took.set(name, ms);
  Object.defineProperty(store, "phase", { value: timer, enumerable: false });
  const realNow = Date.now;
  const clock = [now, now + 40];
  Date.now = () => (clock.length > 1 ? clock.shift() : clock[0]);
  try {
    await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  } finally {
    Date.now = realNow;
  }
  assert.equal(took.get("move_legs_armed"), 26);
  assert.equal(took.has("move_legs_unarmed"), false);
});

test("an object answer without the object's clock records no trip split", async () => {
  const { store } = objectStore({ ok: true, files: [{ from: "a/x.md", to: "b/x.md" }], took: 12, commit: 9 });
  const took = [];
  const timer = (name, run) => run();
  timer.took = (name, ms) => took.push(name);
  Object.defineProperty(store, "phase", { value: timer, enumerable: false });
  await startObjectMove(store, "team", "a/x.md", "b/x.md", undefined, NOTE);
  assert.deepEqual(took, ["move", "move_commit"]);
});

test("archive through the object asks no jobs first: the object finds the Archive itself", async () => {
  const { store, sent } = await archiveStore({ ok: true, to: "4-archive/1-projects/a.md", files: [{ from: "1-projects/a.md", to: "4-archive/1-projects/a.md" }] });
  let asked = 0;
  store.treeFacts = async () => {
    asked += 1;
    return { served: true, jobs: { archive: "4-archive" }, roots: [] };
  };
  const result = await toolArchiveNote(store, "team", ARCHIVE_RULES, new Map(), "1-projects/a.md", "e1");
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(asked, 0);
  assert.equal(sent.length, 1);
});
