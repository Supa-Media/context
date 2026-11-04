/**
 * A NEW PRIVATE NOTE'S FIND AND NAME CHECKS, MADE IN THE CREATE'S OWN TRIP (2026-11-03).
 *
 * A save of a new note asked the workspace object three things side by side before its create (the row lookup, the
 * names on its way, the folder's children: about 25 to 38 ms in production), then made the create. Where nothing the
 * save does before its put needs those answers (a private connection, a private note its folders already make
 * private, no etag, no link, no images), the save now skips them and asks the create to make them
 * (`workspaceStore/createNote.js` `checks`, `store/idLayout.js` `checkedCreate`, `tools/notes/write.js`
 * `mayLeaveChecks`). The object declines, writing nothing, wherever those checks could have said anything, and the
 * save then runs the long way from the start, so every answer is the long way's answer.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-11-03).
 *
 *  1. `checksDecline` returning null always.
 *     → "the object declines, writing nothing, ..." fails.
 *  2. The twin query compared case-sensitively (`path = ?`).
 *     → the twin cases of the same test fail.
 *  3. `checkedCreate` not discarding a served but unadopted key.
 *     → "a note the object would leave to the control plane ..." fails.
 *  4. `toolWriteNote` not rerunning on `CheckedCreateDeclined`.
 *     → "a declined create is saved the long way ..." fails.
 *  5. `mayLeaveChecks` not requiring a private scope.
 *     → "a team connection never leaves its checks" fails.
 *  6. `mayLeaveChecks` not asking `rowAccess.inherits`.
 *     → "a private note in a team folder keeps its checks" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { withIdLayout, CheckedCreateDeclined } from "../src/store/idLayout.js";
import { idKeyFor } from "../src/store/noteIdKeys.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { durableSqlite } from "./durableSqlite.mjs";

const OBJECT_RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }, { prefix: "mine", visibility: "private" }], notes: [] };

/** The workspace object, its notes held there, with a team folder, a private folder, a file and a folder under it. */
function objectWorld() {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql), mirror: mirrorOutbox(sql), mirrorSoon: () => {} };
  store.rows.pinWorkspace("ws");
  store.rows.put([
    { id: "f-projects", path: "1-projects", kind: "folder", at: 1 },
    { id: "f-mine", path: "mine", kind: "folder", at: 1 },
    { id: "f-sub", path: "mine/sub", kind: "folder", at: 1 },
    { id: "n-held", path: "mine/held.md", kind: "file", at: 1 },
  ]);
  store.rows.putRules(OBJECT_RULES, "member");
  store.rows.setHome("object");
  store.rows.markBackfilled(1);
  const calls = [];
  const stub = {
    fetch: (request) => {
      calls.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
      return serveWorkspaceStore(store, request);
    },
  };
  const ask = async (op, fields) =>
    await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  const client = { bodies: new R2Store(texBucket(stub)), collab: { create: (fields) => ask("ws.create", fields) } };
  const { sql: bucketSql } = durableSqlite();
  const bucketStore = { objects: texObjects(bucketSql), rows: workspaceRows(bucketSql) };
  const bucket = new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(bucketStore, request) }));
  const logged = [];
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client, defer: () => {}, log: (event, fields) => logged.push([event, fields.reason]), known: { home: "object", backfilledAt: 1 } });
  const asked = [];
  const keyed = withIdLayout(routed, {
    lookup: async (paths) => (asked.push(["lookup", ...paths]), { keyed: true, notes: {}, texHomes: {} }),
    wrote: async () => ({ recorded: true }),
    adopt: async (record) => (asked.push(["adopt", record.path]), { adopted: true, taken: null }),
    removed: async () => ({ removed: true }),
  });
  return { store, client, routed, keyed, calls, asked, logged };
}

const NOTE_ID = "0199a000-0000-7000-8000-00000000c001";
const created = (path, tier = "private") => ({ path, noteId: NOTE_ID, key: idKeyFor(NOTE_ID, path), text: "# New\n", tier, at: 5, checks: true });

test("the object declines, writing nothing, wherever the save's own checks could have said anything", async () => {
  const cases = [
    ["new.md", "top_level"],
    ["elsewhere/new.md", "top_level"],
    ["mine/held.md", "taken"],
    ["mine/held.md/inner.md", "parent_file"],
    ["Mine/new.md", "top_level"],
    ["mine/Sub/new.md", "twin"],
    ["mine/HELD.md", "twin"],
  ];
  for (const [path, reason] of cases) {
    const { routed, client, store, logged } = objectWorld();
    assert.equal(await routed.createInObject(created(path)), null, path);
    // Only a short code is said, never the path.
    assert.deepEqual(logged, [["workspace_object_create_not_served", reason]], path);
    assert.equal(await client.bodies.get(idKeyFor(NOTE_ID, path)), null, `${path}: bytes were written`);
    assert.notEqual(store.rows.byPath(path)?.noteId, NOTE_ID, `${path}: a row was made`);
  }
});

test("a new note beneath a held folder is made in the one call, new folders on its way included", async () => {
  for (const path of ["mine/new.md", "mine/sub/new.md", "mine/fresh/new.md"]) {
    const { routed, store, calls } = objectWorld();
    const answer = await routed.createInObject(created(path));
    assert.equal(answer.served, true, path);
    assert.equal(answer.adopted, true, `${path}: ${answer.reason}`);
    assert.deepEqual(calls, ["ws.create"]);
    assert.equal(store.rows.byPath(path).noteId, NOTE_ID);
  }
});

test("without `checks`, the create makes none of them: the gateway made its own", async () => {
  const { routed } = objectWorld();
  const { checks, ...unchecked } = created("elsewhere/new.md", "team");
  assert.equal(checks, true);
  const answer = await routed.createInObject(unchecked);
  assert.equal(answer.served, true);
});

test("the id layer's checked create asks no lookup, and returns the adopted note", async () => {
  const { keyed, asked, client } = objectWorld();
  assert.equal(keyed.createsChecked, true);
  assert.equal(Object.keys(keyed).includes("createsChecked"), false, "a store's spread must not carry the flag");
  const put = await keyed.put("mine/new.md", "# New\n", { onlyIf: { absent: true }, tier: "private", checked: true });
  assert.equal(typeof put.etag, "string");
  assert.match(put.key, /^notes\/.+\.md$/);
  assert.deepEqual(asked, [], "the tree was asked");
  assert.equal(await (await client.bodies.get(put.key)).text(), "# New\n");
});

test("a declined checked create throws, nothing written and nothing asked of the tree", async () => {
  const { keyed, asked, store } = objectWorld();
  await assert.rejects(keyed.put("mine/held.md", "# Over\n", { onlyIf: { absent: true }, tier: "private", checked: true }), CheckedCreateDeclined);
  assert.deepEqual(asked, []);
  assert.equal(store.objects.list?.().length ?? 0, 0);
  // Not a tier the object can adopt, or a conditional on an etag: never made checked.
  await assert.rejects(keyed.put("mine/new.md", "# New\n", { tier: "public", checked: true }), CheckedCreateDeclined);
  await assert.rejects(keyed.put("mine/new.md", "# New\n", { onlyIf: { etagMatches: "e" }, tier: "private", checked: true }), CheckedCreateDeclined);
});

test("a note the object would leave to the control plane is discarded, and the create declines", async () => {
  const { keyed, client, asked, store } = objectWorld();
  // The folder is team: a private note there is not adopted in the object (`wider_here`).
  let thrown = null;
  try {
    await keyed.put("1-projects/secret.md", "# Secret\n", { onlyIf: { absent: true }, tier: "private", checked: true });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof CheckedCreateDeclined, String(thrown));
  assert.deepEqual(asked, [], "the control plane was asked to adopt it");
  assert.equal(store.rows.byPath("1-projects/secret.md"), null);
  const left = (await client.bodies.list({ prefix: "notes/" })).objects ?? [];
  assert.deepEqual(left.map((object) => object.key), [], "the unadopted bytes were left behind");
});

/**
 * The write tool over a stub tree: `object` says what the object's checked create answers, and every tree question
 * is logged. The long way's find and name checks are the stub tree's.
 */
function toolWorld({ notes = {}, decline = () => null } = {}) {
  const log = [];
  const objects = new Map();
  const rows = {};
  let version = 0;
  for (const [path, body] of Object.entries(notes)) {
    const noteId = `0190a000-0000-7000-8000-${String(Object.keys(rows).length + 1).padStart(12, "0")}`;
    const key = idKeyFor(noteId, path);
    objects.set(key, { body, etag: `etag-seed-${path}` });
    rows[path] = { state: "keyed", key, etag: `etag-seed-${path}`, noteId };
  }
  const object = (key) => {
    const held = objects.get(key);
    return held ? { key, etag: held.etag, size: held.body.length, text: async () => held.body, arrayBuffer: async () => new TextEncoder().encode(held.body).buffer } : null;
  };
  const write = (key, body) => {
    version += 1;
    objects.set(key, { body: String(body), etag: `etag-${version}` });
    return { etag: `etag-${version}` };
  };
  const bucket = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    get: async (key) => (log.push(["get", key]), object(key)),
    head: async (key) => (log.push(["head", key]), object(key)),
    exists: async (key) => objects.has(key),
    existsMetadata: async (key) => objects.has(key),
    put: async (key, body, options) => {
      log.push(["put", key]);
      if (options?.onlyIf?.absent === true && objects.has(key)) return null;
      if (typeof options?.onlyIf?.etagMatches === "string" && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      return write(key, body);
    },
    delete: async (key) => (log.push(["delete", key]), objects.delete(key)),
    list: async () => ({ objects: [], truncated: false }),
    treeManifest: async () => (log.push(["names"]), { served: true, entries: Object.keys(rows).map((path) => ({ path, etag: rows[path].etag, size: 1, updatedAt: 1 })), cursor: null }),
    treeFacts: async ({ paths }) => (log.push(["facts", ...paths]), { served: true, files: paths.filter((path) => rows[path]), folders: [] }),
    rowAccess: {
      setTier: async (change) => (log.push(["tier", change?.path]), { ok: true }),
      addPeople: async () => ({ ok: true }),
      inherits: (path, tier) => tier === "private" && path.startsWith("mine/"),
    },
    createInObject: async (fields) => {
      log.push(["create", fields.path, fields.checks === true]);
      const reason = fields.checks === true ? decline(fields.path) : null;
      if (reason) return { served: false, reason };
      const put = write(fields.key, fields.text);
      rows[fields.path] = { state: "keyed", key: fields.key, etag: put.etag, noteId: fields.noteId };
      return { served: true, adopted: true, etag: put.etag, size: fields.text.length };
    },
  };
  const store = withIdLayout(bucket, {
    lookup: async (paths) => (log.push(["lookup", ...paths]), { keyed: true, notes: Object.fromEntries(paths.filter((path) => rows[path]).map((path) => [path, { ...rows[path] }])), texHomes: {} }),
    wrote: async (record) => ((rows[record.path] = { ...rows[record.path], etag: record.etag }), { recorded: true }),
    adopt: async (record) => ((rows[record.path] = { state: "keyed", key: record.key, etag: record.etag, noteId: record.noteId }), { adopted: true, taken: null }),
    removed: async () => ({ removed: true }),
  });
  return { store, log, rows, objects };
}

const TOOL_RULES = [{ prefix: "1-projects", vis: "team" }, { prefix: "mine", vis: "private" }];
const before = (log, kind) => log.slice(0, log.findIndex((entry) => entry[0] === "create"));
const treeQuestions = (entries) => entries.filter(([kind]) => kind === "lookup" || kind === "names" || kind === "facts");

test("a new private note in a private folder is saved in the create's one trip, with no find or name check first", async () => {
  const { store, log, rows } = toolWorld();
  const result = await toolWriteNote(store, "private", TOOL_RULES, undefined, { path: "mine/new.md", content: "# New\n\nMade.\n" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(log.filter(([kind]) => kind === "create"), [["create", "mine/new.md", true]]);
  assert.deepEqual(treeQuestions(before(log)), [], JSON.stringify(log));
  assert.equal(rows["mine/new.md"]?.state, "keyed");
});

test("a declined create is saved the long way, and answers as the long way does", async () => {
  // A note already there, a twin of a name on its way: each answered as a save that never tried the short way.
  const cases = [
    { notes: { "mine/held.md": "# Held\n\nKept.\n" }, path: "mine/held.md", reason: "taken" },
    { notes: { "Mine/other.md": "# Other\n" }, path: "mine/new.md", reason: "twin" },
  ];
  for (const { notes, path, reason } of cases) {
    const short = toolWorld({ notes, decline: (asked) => (asked === path ? reason : null) });
    const long = toolWorld({ notes });
    const args = { path, content: "# Written\n\nNew words.\n" };
    const shortResult = await toolWriteNote(short.store, "private", TOOL_RULES, undefined, args);
    const longResult = await toolWriteNote(long.store, "private", TOOL_RULES, undefined, args, { speculate: false });
    const plain = (result) => JSON.stringify(result).replace(/etag-[A-Za-z0-9./-]+/g, "etag").replace(/notes\/[A-Za-z0-9-]+\.md/g, "key");
    assert.equal(plain(shortResult), plain(longResult), reason);
    assert.ok(treeQuestions(short.log).length > 0, `${reason}: the long way was not taken`);
    assert.equal(JSON.stringify([...short.objects.values()].map((o) => o.body).sort()), JSON.stringify([...long.objects.values()].map((o) => o.body).sort()), `${reason}: different notes were left`);
  }
});

test("a team connection never leaves its checks", async () => {
  const { store, log } = toolWorld();
  // Even where the folders would be said to give the tier asked for.
  store.rowAccess.inherits = () => true;
  const result = await toolWriteNote(store, "team", TOOL_RULES, undefined, { path: "1-projects/new.md", content: "# New\n", confirm_team_publish: true });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(log.some(([kind, , checks]) => kind === "create" && checks === true), false, JSON.stringify(log));
});

test("a private note in a team folder keeps its checks: its tier is written before the put", async () => {
  const { store, log } = toolWorld();
  const result = await toolWriteNote(store, "private", TOOL_RULES, undefined, { path: "1-projects/secret.md", content: "# Secret\n" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(log.some(([kind, , checks]) => kind === "create" && checks === true), false);
  assert.ok(treeQuestions(log).length > 0);
});

test("a save with an etag, a link, a top-level path or a Tex path keeps its checks", async () => {
  const saves = [
    { path: "mine/new.md", content: "# New\n", expected_etag: "etag-0" },
    { path: "mine/new.md", content: "# New\n", share: "members" },
    { path: "new.md", content: "# New\n" },
    { path: "tex/new.md", content: "# New\n" },
    { path: "mine/new.md", content: "# New\n", visibility: "team", confirm_team_publish: true },
  ];
  for (const args of saves) {
    const { store, log } = toolWorld();
    await toolWriteNote(store, "private", TOOL_RULES, undefined, args).catch(() => null);
    assert.equal(log.some(([kind, , checks]) => kind === "create" && checks === true), false, JSON.stringify(args));
  }
});
