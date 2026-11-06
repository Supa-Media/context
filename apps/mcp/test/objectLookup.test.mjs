// The id layer's row questions, object first where a workspace's notes are judged in its object
// (src/store/objectLookup.js): a note the reader sees costs one object call; everything the object does not find is
// the control plane's, as before. A guest and a Tex guest chat are judged there by their own audience's rules.
//
// Sabotage, each confirmed to fail a case here: drop the guest-marker check (a guest is judged by member rules),
// judge a chat as a guest (its own rendering dropped), send a chat with no names to the object,
// ignore the binding's `notesBehind` (a share just taken back is served from the object until its push lands),
// take a found row whose path differs from the one asked, take a non-id key, or skip the fallback for misses,
// or judge a guest's keyed write as a member's (`judged.audience !== "member"` → `false` in the `wrote` hook).
import { test } from "node:test";
import assert from "node:assert/strict";

import { audienceOf, objectFirstHooks, readsAsMember, WorkspaceBusy } from "../src/store/objectLookup.js";

const NOTE = "0199a000-0000-7000-8000-00000000000c";
const KEY = `notes/${NOTE}.md`;

function control() {
  const asked = { lookup: [], resolve: [], wrote: [], adopt: [] };
  return {
    asked,
    hooks: {
      adopt: async (note) => {
        asked.adopt.push(note);
        return { adopted: "control", taken: null };
      },
      lookup: async (paths) => {
        asked.lookup.push(paths);
        return { keyed: true, notes: Object.fromEntries(paths.map((path) => [path, { state: "gone" }])), texHomes: { "tex/new.md": "person:w1" } };
      },
      resolve: async (ids) => {
        asked.resolve.push(ids);
        return { paths: Object.fromEntries(ids.map((id) => [id, null])) };
      },
      wrote: async (record) => {
        asked.wrote.push(record);
        return { recorded: "control" };
      },
    },
  };
}

/** `write`: the object's `ws.write.wrote` answer for a call (omit for an object with no write client). */
function object(rows, write) {
  const asked = [];
  const client = {
    rows: {
      lookup: async (fields) => {
        asked.push({ op: "lookup", ...fields });
        return { rows: fields.paths.map((path) => rows[path] ?? { path, found: false }), accessVersion: 3 };
      },
      resolve: async (fields) => {
        asked.push({ op: "resolve", ...fields });
        return { rows: fields.noteIds.map((id) => Object.values(rows).find((row) => row.noteId === id) ?? { noteId: id, found: false }), accessVersion: 3 };
      },
    },
  };
  if (write) {
    client.write = {
      wrote: async (fields) => {
        asked.push({ op: "wrote", ...fields });
        return write(fields);
      },
    };
  }
  return { asked, client };
}

const seen = { found: true, path: "plans/a.md", noteId: NOTE, key: KEY, etag: "e1", kind: "file", collaborates: false };

test("a note the member sees is answered by the object alone", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: new Set(["@design"]), workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md"]);
  assert.deepEqual(answer, { keyed: true, notes: { "plans/a.md": { state: "keyed", key: KEY, etag: "e1", noteId: NOTE } }, texHomes: {} });
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(ob.asked[0], { op: "lookup", paths: ["plans/a.md"], scope: "team", groups: ["@design"], audience: "member" });
  assert.equal(hooks.wrote, cp.hooks.wrote, "every other hook is the control plane's");
});

test("only what the object does not find is asked of the control plane, in one call", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md", "secret/b.md", "tex/new.md"]);
  assert.deepEqual(cp.asked.lookup, [["secret/b.md", "tex/new.md"]]);
  assert.equal(answer.notes["plans/a.md"].state, "keyed");
  assert.deepEqual(answer.notes["secret/b.md"], { state: "gone" });
  assert.deepEqual(answer.texHomes, { "tex/new.md": "person:w1" });
});

test("a guest's reading goes to the object, judged by the guest rules with the guest's own names", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const names = new Set(["@#reads-as-guest", "@#0199a000-0000-7000-8000-00000000000c"]);
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names, userId: "u1", workspaceId: "w1" });
  await hooks.lookup(["plans/a.md"]);
  await hooks.resolve([NOTE]);
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(ob.asked[0], { op: "lookup", paths: ["plans/a.md"], scope: "team", groups: [...names], audience: "guest" });
  assert.equal(ob.asked[1].audience, "guest");
  assert.equal("userId" in ob.asked[0], false, "a guest is never judged as a member here");
});

test("a chat's reading goes to the object with its own names; a chat whose names are not known stays with the control plane", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const names = new Set(["@#reads-as-chat"]);
  const chatNames = ["@#reads-as-guest", "@#reads-as-chat", "@#home", "@#home!edit"];
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names, chatNames, userId: "u1", workspaceId: "w1" });
  await hooks.lookup(["plans/a.md"]);
  assert.deepEqual(ob.asked[0], { op: "lookup", paths: ["plans/a.md"], scope: "team", groups: ["@#reads-as-chat"], audience: "chat", chatNames });

  for (const missing of [null, undefined, "@#home"]) {
    const control2 = control();
    const ob2 = object({ "plans/a.md": seen });
    const unnamed = objectFirstHooks(control2.hooks, { client: ob2.client, home: "object", scope: "team", names, chatNames: missing, workspaceId: "w1" });
    assert.equal(unnamed, control2.hooks);
  }
  // A chat marker wins over a guest's: the chat is read by its own rendering, never the guest's alone.
  assert.equal(audienceOf(["@#reads-as-guest", "@#reads-as-chat"]), "chat");
  assert.equal(audienceOf(["@#reads-as-guest"]), "guest");
  assert.equal(readsAsMember(["@design"]), true);
  assert.equal(readsAsMember(["@#reads-as-guest"]), false);
  // A row token is a member's named grant, judged by the object with the member's rules.
  assert.equal(readsAsMember(["@#0199a000-0000-7000-8000-00000000000c"]), true);
});

test("a workspace not at home in its object keeps the control plane's hooks as they are", async () => {
  const cp = control();
  for (const home of ["bucket", "dual", null, undefined]) {
    assert.equal(objectFirstHooks(cp.hooks, { client: object({}).client, home, scope: "team", names: [], workspaceId: "w1" }), cp.hooks);
  }
  assert.equal(objectFirstHooks(cp.hooks, { client: null, home: "object", scope: "team", names: [], workspaceId: "w1" }), cp.hooks);
});

test("a binding that says the object is behind sends every question to the control plane", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const logged = [];
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", behind: true, scope: "team", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  assert.equal(hooks, cp.hooks);
  await hooks.lookup(["plans/a.md"]);
  assert.equal(ob.asked.length, 0, "a share just taken back is never answered from the object's older rows");
  assert.deepEqual(logged, ["workspace_object_behind"]);
});

// Never the control plane instead (the owner, 2026-11-06): it read the same busy object through its door. Sabotage:
// put back `return await hooks.lookup(paths)` on a failure, and this fails.
test("an object that fails is busy, logged, and the control plane is not asked", async () => {
  const cp = control();
  const logged = [];
  const failing = { rows: { lookup: async () => { throw new Error("down"); }, resolve: async () => { throw new Error("down"); } } };
  const hooks = objectFirstHooks(cp.hooks, { client: failing, home: "object", scope: "private", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  await assert.rejects(hooks.lookup(["plans/a.md"]), WorkspaceBusy);
  await assert.rejects(hooks.resolve([NOTE]), WorkspaceBusy);
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(cp.asked.resolve, []);
  assert.deepEqual(logged, ["workspace_object_lookup_failed", "workspace_object_resolve_failed"]);
});

test("a row that is not plainly this path's note is the control plane's to answer", async () => {
  const cases = {
    "a/other.md": { ...seen, path: "a/elsewhere.md" },
    "a/tex.md": { ...seen, path: "a/tex.md", key: "tex/w1/notes/x.md" },
    "a/noetag.md": { ...seen, path: "a/noetag.md", etag: null },
  };
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, { client: object(cases).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  await hooks.lookup(Object.keys(cases));
  assert.deepEqual(cp.asked.lookup, [Object.keys(cases)]);
});

test("a path the object answers absent is made without the control plane: all absent never calls hooks.lookup", async () => {
  const cp = control();
  const absent = { "plans/a.md": { path: "plans/a.md", found: false, absent: true }, "plans/b.md": { path: "plans/b.md", found: false, absent: true } };
  const ob = object(absent);
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md", "plans/b.md"]);
  assert.deepEqual(answer, { keyed: true, notes: {}, texHomes: {} });
  assert.deepEqual(cp.asked.lookup, [], "no control-plane call for a path the object judged absent");
  assert.equal(ob.asked.length, 1, "the object was asked once, for both paths");
});

test("a mix: only the path the object does not call absent goes to hooks.lookup", async () => {
  const cp = control();
  const ob = object({
    "plans/a.md": { path: "plans/a.md", found: false, absent: true },
    "secret/b.md": { path: "secret/b.md", found: false },
  });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md", "secret/b.md"]);
  assert.deepEqual(cp.asked.lookup, [["secret/b.md"]], "a plain found:false is not absent: the control plane judges it");
  assert.deepEqual(answer, { keyed: true, notes: { "secret/b.md": { state: "gone" } }, texHomes: { "tex/new.md": "person:w1" } });
});

test("a folder is answered as a folder", async () => {
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, {
    client: object({ plans: { found: true, path: "plans", kind: "folder", noteId: null, key: null, etag: null } }).client,
    home: "object",
    scope: "team",
    names: [],
    workspaceId: "w1",
  });
  assert.deepEqual((await hooks.lookup(["plans"])).notes, { plans: { state: "folder" } });
});

test("resolve: a note's path from the object; under a dot folder from the control plane; a miss the object judged is null, with no control-plane call", async () => {
  const cp = control();
  const hidden = "0199a000-0000-7000-8000-00000000000d";
  const rows = { "plans/a.md": seen, ".trash/b.md": { ...seen, path: ".trash/b.md", noteId: hidden } };
  const hooks = objectFirstHooks(cp.hooks, { client: object(rows).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const missing = "0199a000-0000-7000-8000-00000000000e";
  const answer = await hooks.resolve([NOTE, hidden, missing]);
  // The dot-folder id is found by the object but filtered by the gateway, so it falls through; the miss does not.
  assert.deepEqual(cp.asked.resolve, [[hidden]]);
  assert.deepEqual(answer.paths, { [NOTE]: "plans/a.md", [hidden]: null, [missing]: null });
});

// An id the object does not find, while it is not behind, is the object's answer: `null`, which the control plane also
// gives for a gone row, a trashed note, a note the reader may not see, and an id with no row. Sabotage: drop the
// not-found branch in objectLookup.js and the first case here fails, since the control plane is then asked.
const MISSING = "0199a000-0000-7000-8000-00000000000e";

test("an id the object does not find, and is not behind, is null with no control-plane call", async () => {
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, { client: object({ "plans/a.md": seen }).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.deepEqual(await hooks.resolve([MISSING]), { paths: { [MISSING]: null } });
  assert.deepEqual(await hooks.resolve([NOTE, MISSING]), { paths: { [NOTE]: "plans/a.md", [MISSING]: null } });
  assert.deepEqual(cp.asked.resolve, []);
});

test("behind is busy for a not-found id as well", async () => {
  const cp = control();
  const ob = object({});
  const behind = { rows: { resolve: async (fields) => ({ ...(await ob.client.rows.resolve(fields)), behind: true }) } };
  const hooks = objectFirstHooks(cp.hooks, { client: behind, home: "object", scope: "team", names: [], workspaceId: "w1" });
  await assert.rejects(hooks.resolve([MISSING]), WorkspaceBusy);
  assert.deepEqual(cp.asked.resolve, []);
});

// The object returns no path for a note the reader may not see; a path on a not-found row is never read. Sabotage:
// take `row.path` from a found:false row, and this fails.
test("a note the reader may not see is never returned, even when the object's row carries a path", async () => {
  const cp = control();
  const client = { rows: { resolve: async () => ({ rows: [{ noteId: NOTE, found: false, path: "secret/plan.md" }], accessVersion: 3 }) } };
  const hooks = objectFirstHooks(cp.hooks, { client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const answer = await hooks.resolve([NOTE]);
  assert.deepEqual(answer, { paths: { [NOTE]: null } });
  assert.equal(JSON.stringify(answer).includes("secret/plan.md"), false);
  assert.deepEqual(cp.asked.resolve, []);
});

// Two live rows hold one note id: the object names neither (`ambiguous`), and the control plane answers, as it does for
// an id held twice. Sabotage: treat ambiguous as not found, and the control plane's answer is replaced by null.
test("two live rows for one note id fall through to the control plane, and neither object path is returned", async () => {
  const asked = [];
  const cp = { hooks: { resolve: async (ids) => { asked.push(ids); return { paths: { [NOTE]: "from/control.md" } }; } } };
  const client = { rows: { resolve: async () => ({ rows: [{ noteId: NOTE, found: false, ambiguous: true, path: "plans/a.md" }], accessVersion: 3 }) } };
  const hooks = objectFirstHooks(cp.hooks, { client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.deepEqual(await hooks.resolve([NOTE]), { paths: { [NOTE]: "from/control.md" } });
  assert.deepEqual(asked, [[NOTE]]);
});

// Behind by the object's own word: a writer that may narrow left a mark there, and its change has not landed. The
// control plane is never asked beside the object (2026-11-02: every narrowing writer goes first). Sabotage, each
// confirmed to fail a case here: ignore the object's `behind`, or ask the control plane before the object answers.
test("the object's own behind makes lookup and resolve busy even when it found the note", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const behind = {
    rows: {
      lookup: async (fields) => ({ ...(await ob.client.rows.lookup(fields)), behind: true }),
      resolve: async (fields) => ({ ...(await ob.client.rows.resolve(fields)), behind: true }),
    },
  };
  const logged = [];
  const hooks = objectFirstHooks(cp.hooks, { client: behind, home: "object", scope: "team", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  // A share just taken back is never served from the object's older rows: the reader is told to try again.
  await assert.rejects(hooks.lookup(["plans/a.md"]), WorkspaceBusy);
  await assert.rejects(hooks.resolve([NOTE]), WorkspaceBusy);
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(cp.asked.resolve, []);
  assert.deepEqual(logged, ["workspace_object_behind", "workspace_object_behind"]);
});

test("an object that is not behind is the whole answer: the control plane is not asked", async () => {
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, { client: object({ "plans/a.md": seen }).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.deepEqual((await hooks.lookup(["plans/a.md"])).notes, { "plans/a.md": { state: "keyed", key: KEY, etag: "e1", noteId: NOTE } });
  assert.deepEqual(await hooks.resolve([NOTE]), { paths: { [NOTE]: "plans/a.md" } });
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(cp.asked.resolve, []);
});

// A member's keyed write, recorded in the object first (`ws.write.wrote`), so the save waits on no control-plane
// round trip. Sabotage, confirmed to fail a case here: drop the member-audience check, so a guest's write goes to the object.
const KEYED = { path: "plans/a.md", key: KEY, etag: "e2", size: 10, at: 99, keyed: true };

test("a member's keyed write with its size and time is recorded in the object, not the control plane", async () => {
  const cp = control();
  const ob = object({}, () => ({ ok: true }));
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1" });
  assert.equal(typeof hooks.wrote, "function");
  assert.notEqual(hooks.wrote, cp.hooks.wrote);
  // So a save run in the object may record its version there in the same call (`workspaceStore/collabReplace.js`).
  assert.equal(hooks.wrote.inObject, true);
  assert.deepEqual(await hooks.wrote({ ...KEYED, keyEtag: "k1" }), { recorded: true });
  assert.deepEqual(ob.asked, [{ op: "wrote", path: "plans/a.md", key: KEY, etag: "e2", size: 10, at: 99, keyed: true }]);
  assert.deepEqual(cp.asked.wrote, [], "the control plane is not asked when the object takes the write");
});

test("a keyed write the object is not sent (not keyed, no size, no time) is recorded by the control plane, as before", async () => {
  const notSent = [
    { ...KEYED, keyed: false },
    { ...KEYED, size: undefined },
    { ...KEYED, at: undefined },
    { ...KEYED, size: Number.NaN },
  ];
  for (const record of notSent) {
    const cp = control();
    const ob = object({}, () => ({ ok: true }));
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
    assert.deepEqual(await hooks.wrote(record), { recorded: "control" }, JSON.stringify(record));
    assert.deepEqual(cp.asked.wrote, [record]);
    assert.deepEqual(ob.asked, [], "the object is not asked");
  }
});

test("an object that does not take the write (NOT_FOUND, or anything not ok) falls back to the control plane", async () => {
  for (const answer of [{ ok: false, code: "NOT_FOUND" }, { ok: false }, {}, undefined]) {
    const cp = control();
    const ob = object({}, () => answer);
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
    assert.deepEqual(await hooks.wrote(KEYED), { recorded: "control" }, JSON.stringify(answer));
    assert.deepEqual(cp.asked.wrote, [KEYED]);
    assert.equal(ob.asked.length, 1, "the object was asked first");
  }
});

test("an object that throws on the write falls back to the control plane, logged", async () => {
  const cp = control();
  const logged = [];
  const ob = object({}, () => {
    throw new Error("down");
  });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  assert.deepEqual(await hooks.wrote(KEYED), { recorded: "control" });
  assert.deepEqual(cp.asked.wrote, [KEYED]);
  assert.deepEqual(logged, ["workspace_object_wrote_failed"]);
});

test("a guest's or a chat's keyed write is never recorded in the object: the control plane's wrote, unchanged", async () => {
  const readers = [
    { names: ["@#reads-as-guest", "@#0199a000-0000-7000-8000-00000000000c"] },
    { names: ["@#reads-as-chat"], chatNames: [] },
  ];
  for (const { names, chatNames = null } of readers) {
    const cp = control();
    const ob = object({}, () => ({ ok: true }));
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names, chatNames, userId: "u1", workspaceId: "w1" });
    assert.equal(hooks.wrote, cp.hooks.wrote, "the control plane's own hook");
    assert.notEqual(hooks.wrote.inObject, true, "a guest's save must not be recorded in the object");
    assert.deepEqual(await hooks.wrote(KEYED), { recorded: "control" });
    assert.deepEqual(cp.asked.wrote, [KEYED]);
    assert.deepEqual(ob.asked, [], "the object is never asked to record it");
  }
});

test("without an object write client, or without an object, wrote is the control plane's", async () => {
  const cp = control();
  const noWrite = objectFirstHooks(cp.hooks, { client: object({}).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.equal(noWrite.wrote, cp.hooks.wrote);
  const noObject = objectFirstHooks(cp.hooks, { client: null, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.equal(noObject, cp.hooks);
  assert.equal(noObject.wrote, cp.hooks.wrote);
});

// ---- adopt: a member's create that names its tier goes to the object's `ws.write.adopt` first -----------------------

/** A new note as the id layer hands it to `hooks.adopt`: a plain `team` create, unless a case overrides it. */
const CREATE = { path: "plans/new.md", noteId: "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f60", key: "notes/01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f60.md", etag: "e-new", size: 5, at: 300, tier: "team" };

/** An object with a `write.adopt` that answers `answer(fields)`, or throws when `answer` is an Error. */
function objectAdopting(answer) {
  const asked = [];
  const client = {
    rows: {
      lookup: async () => {
        throw new Error("not used by adopt");
      },
      resolve: async () => {
        throw new Error("not used by adopt");
      },
    },
    write: {
      adopt: async (fields) => {
        asked.push(fields);
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(fields) : answer;
      },
    },
  };
  return { asked, client };
}

test("a member's create with a tier is adopted by the object: {adopted, taken: null}, and the control plane is not asked", async () => {
  const cp = control();
  const ob = objectAdopting({ ok: true, adopted: true, at: 999 });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1" });
  assert.notEqual(hooks.adopt, cp.hooks.adopt);
  assert.deepEqual(await hooks.adopt(CREATE), { adopted: true, taken: null });
  assert.deepEqual(ob.asked, [{ path: CREATE.path, noteId: CREATE.noteId, key: CREATE.key, etag: "e-new", size: 5, at: 300, tier: "team" }]);
  assert.deepEqual(cp.asked.adopt, [], "hooks.adopt is not called when the object adopts");
});

test("the tier and a private create are passed to the object as the writer named them, and a missing size is left out", async () => {
  const cp = control();
  const ob = objectAdopting({ ok: true, adopted: true, at: 1 });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const { size: _size, ...noSize } = CREATE;
  await hooks.adopt({ ...noSize, tier: "private" });
  assert.equal(ob.asked[0].tier, "private");
  assert.equal("size" in ob.asked[0], false);
});

test("an object that answers DEFER falls back to hooks.adopt, and its answer is the control plane's", async () => {
  for (const answer of [{ ok: false, code: "DEFER" }, { ok: true, adopted: false }, {}, undefined]) {
    const cp = control();
    const ob = objectAdopting(answer);
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1" });
    assert.deepEqual(await hooks.adopt(CREATE), { adopted: "control", taken: null }, JSON.stringify(answer));
    assert.deepEqual(cp.asked.adopt, [CREATE], JSON.stringify(answer));
    assert.equal(ob.asked.length, 1, "the object was asked first");
  }
});

test("a deferred adoption is logged with the object's reason and never the path", async () => {
  const cp = control();
  const logged = [];
  const ob = objectAdopting({ ok: false, code: "DEFER", reason: "job_folder" });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1", log: (event, fields) => logged.push([event, fields]) });
  await hooks.adopt(CREATE);
  assert.deepEqual(logged, [["workspace_object_adopt_deferred", { workspaceId: "w1", code: "DEFER", reason: "job_folder" }]]);
  assert.ok(!JSON.stringify(logged).includes(CREATE.path));
});

test("an object that throws on the adopt falls back to hooks.adopt, logged", async () => {
  const cp = control();
  const logged = [];
  const ob = objectAdopting(new Error("down"));
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1", log: (event) => logged.push(event) });
  assert.deepEqual(await hooks.adopt(CREATE), { adopted: "control", taken: null });
  assert.deepEqual(cp.asked.adopt, [CREATE]);
  assert.deepEqual(logged, ["workspace_object_adopt_failed"]);
});

test("a create without a tier, or with a tier that is neither private nor team, never calls the object", async () => {
  for (const override of [{ tier: undefined }, { tier: "public" }, { tier: null }]) {
    const cp = control();
    const ob = objectAdopting({ ok: true, adopted: true, at: 1 });
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1" });
    const note = { ...CREATE, ...override };
    if (override.tier === undefined) delete note.tier;
    assert.deepEqual(await hooks.adopt(note), { adopted: "control", taken: null }, JSON.stringify(override));
    assert.deepEqual(cp.asked.adopt, [note], JSON.stringify(override));
    assert.deepEqual(ob.asked, [], "the object is never asked for a create without a tier it can judge");
  }
});

test("a guest's or a chat's create is never adopted by the object: hooks.adopt is the control plane's own", async () => {
  const readers = [
    { names: ["@#reads-as-guest", "@#0199a000-0000-7000-8000-00000000000c"] },
    { names: ["@#reads-as-chat"], chatNames: [] },
  ];
  for (const { names, chatNames = null } of readers) {
    const cp = control();
    const ob = objectAdopting({ ok: true, adopted: true, at: 1 });
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names, chatNames, userId: "u1", workspaceId: "w1" });
    assert.equal(hooks.adopt, cp.hooks.adopt, "the control plane's own hook");
    assert.deepEqual(await hooks.adopt(CREATE), { adopted: "control", taken: null });
    assert.deepEqual(cp.asked.adopt, [CREATE]);
    assert.deepEqual(ob.asked, [], "the object is never asked to adopt it");
  }
});

test("without an object write client for adopt, or without an object, adopt is the control plane's", async () => {
  const cp = control();
  const noWrite = objectFirstHooks(cp.hooks, { client: object({}).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.equal(noWrite.adopt, cp.hooks.adopt);
  const noObject = objectFirstHooks(cp.hooks, { client: null, home: "object", scope: "team", names: [], workspaceId: "w1" });
  assert.equal(noObject.adopt, cp.hooks.adopt);
});
test("a read's lookup: a path the object does not find, while not behind, is no note, with no control-plane call", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: new Set(), workspaceId: "w1" });
  const answer = await hooks.lookupRead(["plans/a.md", "plans/missing.md"]);
  assert.deepEqual(cp.asked.lookup, []);
  assert.equal(answer.keyed, true);
  assert.equal(answer.notes["plans/a.md"].key, KEY);
  assert.equal(answer.notes["plans/missing.md"], undefined);
  // A write's lookup still asks the control plane for the miss: a new note's Tex home is only known there.
  const written = await hooks.lookup(["plans/missing.md"]);
  assert.deepEqual(cp.asked.lookup, [["plans/missing.md"]]);
  assert.deepEqual(written.texHomes, { "tex/new.md": "person:w1" });
});

test("a read's lookup is busy when the object is behind or fails, and asks the control plane for some other path", async () => {
  for (const variant of ["behind", "fails", "other path"]) {
    const cp = control();
    const ob = object({});
    if (variant === "behind") {
      const plain = ob.client.rows.lookup;
      ob.client.rows.lookup = async (fields) => ({ ...(await plain(fields)), behind: true });
    } else if (variant === "fails") {
      ob.client.rows.lookup = async () => {
        throw new Error("down");
      };
    } else {
      ob.client.rows.lookup = async (fields) => ({ rows: fields.paths.map(() => ({ path: "elsewhere.md", found: false })) });
    }
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: new Set(), workspaceId: "w1" });
    if (variant === "other path") {
      await hooks.lookupRead(["plans/missing.md"]);
      assert.deepEqual(cp.asked.lookup, [["plans/missing.md"]], variant);
    } else {
      await assert.rejects(hooks.lookupRead(["plans/missing.md"]), WorkspaceBusy, variant);
      assert.deepEqual(cp.asked.lookup, [], variant);
    }
  }
});
