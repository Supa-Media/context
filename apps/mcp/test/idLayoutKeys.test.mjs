/**
 * The id layer once the layout is "keys" (`store/idLayout.js`): a keyed note's
 * bytes live only at its id key, and a note created in a keyed workspace is
 * born there, with its id minted before a byte is written.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - read a keyed note from its path: the frozen-copy case fails;
 *  - let a read with no row fall back to the path: the deleted-note case fails;
 *  - drop the legacy etag translation: the old-etag case fails;
 *  - ask for the row before writing the bytes: the create-order case fails;
 *  - keep the bytes of a create whose name was taken: the taken case fails;
 *  - delete the key before retiring the row: the delete-order case fails;
 *  - swallow a failed lookup: the strict case fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NoteNameTaken, withIdLayout } from "../src/store/idLayout.js";
import { idKeyFor, isNoteId } from "../src/store/noteIdKeys.js";
import { storeForSession } from "../src/sessionStore.js";
import { createControlPlane } from "../src/controlPlane/index.js";
import { isIdKey } from "../src/privacy/engine.js";

/* ------------------------------ fixtures ------------------------------- */

function bucket() {
  const log = [];
  const objects = new Map();
  let counter = 0;
  return {
    log,
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      log.push(["get", key]);
      const value = objects.get(key);
      return value ? fileOf(value) : null;
    },
    async head(key) {
      log.push(["head", key]);
      const value = objects.get(key);
      return value ? { etag: value.etag, size: value.body.length } : null;
    },
    async exists(key) {
      log.push(["exists", key]);
      return objects.has(key);
    },
    async put(key, body, options = {}) {
      log.push(["put", key, options]);
      const existing = objects.get(key);
      if (options.onlyIf?.absent === true && existing) return null;
      if (options.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `e${++counter}`;
      objects.set(key, { body: await textOf(body), etag, contentType: options.httpMetadata?.contentType });
      return { etag };
    },
    async copy(source, destination) {
      log.push(["copy", source, destination]);
      const value = objects.get(source);
      if (!value) return null;
      const etag = `e${++counter}`;
      objects.set(destination, { ...value, etag });
      return { etag };
    },
    async delete(key) {
      log.push(["delete", key]);
      objects.delete(key);
    },
    async list() {
      log.push(["list"]);
      return { objects: [], truncated: false };
    },
  };
}

function fileOf(value) {
  const bytes = new TextEncoder().encode(value.body);
  return {
    etag: value.etag,
    size: bytes.byteLength,
    contentType: value.contentType,
    text: async () => value.body,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

async function textOf(body) {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

const KEY = "notes/0192f1a2-3b4c-7d5e-8f60-000000000001.md";
const OTHER_KEY = "notes/0192f1a2-3b4c-7d5e-8f60-000000000002.md";

/**
 * A keyed workspace's control plane over a table of entries, recording every
 * call in order on `calls` so a test can say what happened first.
 */
function controlPlaneOver(notes, { keyed = true, adoptAnswer = null } = {}) {
  const calls = [];
  return {
    calls,
    notes,
    hooks: {
      mode: "keys",
      lookup: async (paths) => {
        calls.push(["lookup", paths]);
        return {
          copies: {},
          keyed,
          notes: Object.fromEntries(paths.filter((path) => notes[path]).map((path) => [path, notes[path]])),
        };
      },
      wrote: async (record) => {
        calls.push(["wrote", record]);
        if (notes[record.path]?.state === "keyed") notes[record.path] = { ...notes[record.path], etag: record.etag };
        return { recorded: true };
      },
      adopt: async (note) => {
        calls.push(["adopt", note]);
        if (adoptAnswer !== null) return adoptAnswer;
        notes[note.path] = { state: "keyed", key: note.key, etag: note.etag, noteId: note.noteId };
        return { adopted: true, taken: null };
      },
      removed: async (note) => {
        calls.push(["removed", note]);
        notes[note.path] = { state: "gone" };
        return { removed: true };
      },
      now: () => 1_700_000_000_000,
    },
  };
}

/** A keyed note `1-projects/a.md` whose bytes are at KEY, with a frozen old copy still at its path. */
async function keyedNote() {
  const store = bucket();
  const atKey = await store.put(KEY, "KEY BODY");
  await store.put("1-projects/a.md", "FROZEN PATH BODY");
  store.log.length = 0;
  const cp = controlPlaneOver({ "1-projects/a.md": { state: "keyed", key: KEY, etag: atKey.etag, legacyEtag: "path-etag" } });
  return { store, cp, layered: withIdLayout(store, cp.hooks) };
}

const puts = (store) => store.log.filter(([op]) => op === "put").map(([, key]) => key);

/* -------------------------------- reads -------------------------------- */

test("a keyed note is read from its key, never from the frozen copy at its path", async () => {
  const { store, layered } = await keyedNote();
  const object = await layered.get("1-projects/a.md");
  assert.equal(await object.text(), "KEY BODY");
  assert.equal(object.etag, store.objects.get(KEY).etag);
  assert.equal((await layered.head("1-projects/a.md")).etag, store.objects.get(KEY).etag);
  assert.equal(await layered.exists("1-projects/a.md"), true);
  assert.ok(!store.log.some(([, key]) => key === "1-projects/a.md"));
});

test("a keyed workspace has no note where the tree has no live row, whatever the path still holds", async () => {
  const store = bucket();
  await store.put("1-projects/deleted.md", "OLD");
  await store.put("1-projects/unknown.md", "STRAY");
  const cp = controlPlaneOver({ "1-projects/deleted.md": { state: "gone" } });
  const layered = withIdLayout(store, cp.hooks);
  assert.equal(await layered.get("1-projects/deleted.md"), null);
  assert.equal(await layered.get("1-projects/unknown.md"), null);
  assert.equal(await layered.head("1-projects/unknown.md"), null);
  assert.equal(await layered.exists("1-projects/unknown.md"), false);
});

test("a workspace that is not keyed yet still reads its paths in the keys layout", async () => {
  const store = bucket();
  await store.put("1-projects/a.md", "PATH BODY");
  const cp = controlPlaneOver({}, { keyed: false });
  const layered = withIdLayout(store, cp.hooks);
  assert.equal(await (await layered.get("1-projects/a.md")).text(), "PATH BODY");
});

test("a failed lookup fails the request in the keys layout: a path read could be a frozen copy", async () => {
  const { store, cp } = await keyedNote();
  const layered = withIdLayout(store, {
    ...cp.hooks,
    lookup: async () => {
      throw new Error("control plane down");
    },
  });
  await assert.rejects(layered.get("1-projects/a.md"), /control plane down/);
  await assert.rejects(layered.put("1-projects/a.md", "x"), /control plane down/);
});

test("plumbing is never looked up", async () => {
  const { store, cp, layered } = await keyedNote();
  await store.put(".context/state.json", "{}");
  assert.equal(await (await layered.get(".context/state.json")).text(), "{}");
  await layered.put("privacy.md", "rules");
  await layered.get(KEY);
  assert.deepEqual(cp.calls, []);
});

/* -------------------------------- writes ------------------------------- */

test("a keyed write lands on the key against the key's version, and is reported with its size", async () => {
  const { store, cp, layered } = await keyedNote();
  const before = store.objects.get(KEY).etag;
  const result = await layered.put("1-projects/a.md", "EDITED", { onlyIf: { etagMatches: before } });
  assert.equal(store.objects.get(KEY).body, "EDITED");
  assert.equal(store.objects.get("1-projects/a.md").body, "FROZEN PATH BODY");
  assert.deepEqual(puts(store), [KEY]);
  const reported = cp.calls.find(([name]) => name === "wrote")[1];
  assert.deepEqual(reported, {
    path: "1-projects/a.md",
    key: KEY,
    etag: result.etag,
    size: 6,
    at: 1_700_000_000_000,
    keyed: true,
  });
});

test("a keyed write against a stale version fails and reports nothing", async () => {
  const { store, cp, layered } = await keyedNote();
  assert.equal(await layered.put("1-projects/a.md", "EDITED", { onlyIf: { etagMatches: "stale" } }), null);
  assert.equal(store.objects.get(KEY).body, "KEY BODY");
  assert.ok(!cp.calls.some(([name]) => name === "wrote"));
  assert.equal(await layered.put("1-projects/a.md", "EDITED", { onlyIf: { absent: true } }), null);
});

test("a client still holding the path's old etag saves once against the key, while the note is unchanged", async () => {
  const { store, layered } = await keyedNote();
  const result = await layered.put("1-projects/a.md", "FROM AN OLD TAB", { onlyIf: { etagMatches: "path-etag" } });
  assert.ok(result);
  assert.equal(store.objects.get(KEY).body, "FROM AN OLD TAB");
});

test("a create in a keyed workspace writes a new id key first, then asks for the row, and never writes the path", async () => {
  const store = bucket();
  const cp = controlPlaneOver({});
  let landedFirst = null;
  const layered = withIdLayout(store, {
    ...cp.hooks,
    adopt: async (note) => {
      landedFirst = store.objects.get(note.key)?.body ?? null;
      return await cp.hooks.adopt(note);
    },
  });
  const result = await layered.put("1-projects/new.md", "HELLO", { onlyIf: { absent: true } });
  assert.ok(result);
  const [key] = puts(store);
  assert.ok(isIdKey(key), key);
  assert.equal(store.objects.get(key).body, "HELLO");
  assert.equal(store.objects.has("1-projects/new.md"), false);
  const adopt = cp.calls.find(([name]) => name === "adopt")[1];
  assert.ok(isNoteId(adopt.noteId));
  assert.equal(adopt.key, idKeyFor(adopt.noteId, "1-projects/new.md"));
  assert.equal(adopt.key, key);
  assert.deepEqual({ path: adopt.path, etag: adopt.etag, size: adopt.size }, { path: "1-projects/new.md", etag: result.etag, size: 5 });
  // The bytes were at the key before the row named them.
  assert.equal(landedFirst, "HELLO");
  assert.equal(await (await layered.get("1-projects/new.md")).text(), "HELLO");
});

test("a file that is not Markdown is created under files/ with its extension", async () => {
  const store = bucket();
  const layered = withIdLayout(store, controlPlaneOver({}).hooks);
  await layered.put("3-resources/scan.PDF", new Uint8Array([1, 2, 3]));
  const [key] = puts(store);
  assert.match(key, /^files\/[0-9a-f-]{36}\.pdf$/);
});

test("a create never answers a precondition on a version that does not exist", async () => {
  const store = bucket();
  const cp = controlPlaneOver({});
  const layered = withIdLayout(store, cp.hooks);
  assert.equal(await layered.put("1-projects/new.md", "x", { onlyIf: { etagMatches: "e9" } }), null);
  assert.deepEqual(puts(store), []);
  assert.ok(!cp.calls.some(([name]) => name === "adopt"));
});

test("a create whose name was taken meanwhile removes its bytes, and an absent-only write gives up", async () => {
  const store = bucket();
  const cp = controlPlaneOver({}, { adoptAnswer: { adopted: false, taken: { state: "keyed", key: OTHER_KEY, etag: "x" } } });
  const layered = withIdLayout(store, cp.hooks);
  assert.equal(await layered.put("1-projects/new.md", "MINE", { onlyIf: { absent: true } }), null);
  assert.deepEqual([...store.objects.keys()], []);
});

test("an unconditional create whose name was taken writes the note that holds it", async () => {
  const store = bucket();
  await store.put(OTHER_KEY, "THEIRS");
  const cp = controlPlaneOver({}, { adoptAnswer: { adopted: false, taken: { state: "keyed", key: OTHER_KEY, etag: "e1" } } });
  const layered = withIdLayout(store, cp.hooks);
  assert.ok(await layered.put("1-projects/new.md", "MINE"));
  assert.deepEqual([...store.objects.keys()], [OTHER_KEY]);
  assert.equal(store.objects.get(OTHER_KEY).body, "MINE");
  assert.equal(cp.calls.filter(([name]) => name === "wrote").length, 1);
});

test("a create whose row was refused outright removes its bytes and fails", async () => {
  const store = bucket();
  const layered = withIdLayout(store, controlPlaneOver({}, { adoptAnswer: { adopted: false, taken: null } }).hooks);
  await assert.rejects(layered.put("1-projects/new.md", "MINE"), NoteNameTaken);
  assert.deepEqual([...store.objects.keys()], []);
});

test("a create whose adoption throws removes its bytes and rejects", async () => {
  const store = bucket();
  const cp = controlPlaneOver({});
  const layered = withIdLayout(store, {
    ...cp.hooks,
    adopt: async () => {
      throw new Error("refused");
    },
  });
  await assert.rejects(layered.put("1-projects/new.md", "MINE"), /refused/);
  assert.deepEqual([...store.objects.keys()], []);
});

test("a write onto a folder's name in a keyed workspace is refused", async () => {
  const store = bucket();
  const layered = withIdLayout(store, controlPlaneOver({ "1-projects": { state: "folder" } }).hooks);
  await assert.rejects(layered.put("1-projects", "x"), NoteNameTaken);
});

test("a note still at its path while its workspace is being keyed is written there and mirrored", async () => {
  const store = bucket();
  await store.put("1-projects/a.md", "OLD");
  const cp = controlPlaneOver({ "1-projects/a.md": { state: "path", key: KEY, etag: "e1", keyEtag: null, fresh: false } });
  const layered = withIdLayout(store, cp.hooks);
  await layered.put("1-projects/a.md", "NEW");
  assert.equal(store.objects.get("1-projects/a.md").body, "NEW");
  assert.equal(store.objects.get(KEY).body, "NEW");
  const reported = cp.calls.find(([name]) => name === "wrote")[1];
  assert.equal(reported.keyed, undefined);
});

/* ------------------------------- deletes ------------------------------- */

test("deleting a keyed note retires its row before its key, and leaves the frozen path alone", async () => {
  const { store, cp, layered } = await keyedNote();
  const order = [];
  const tracing = withIdLayout(
    { ...store, delete: async (key) => (order.push(["delete", key]), store.delete(key)) },
    { ...cp.hooks, removed: async (note) => (order.push(["removed", note.path]), cp.hooks.removed(note)) },
  );
  await tracing.delete("1-projects/a.md");
  assert.deepEqual(order, [["removed", "1-projects/a.md"], ["delete", KEY]]);
  assert.equal(store.objects.has("1-projects/a.md"), true);
  assert.equal(await layered.get("1-projects/a.md"), null);
});

test("a delete against a stale version is refused and retires nothing", async () => {
  const { store, cp, layered } = await keyedNote();
  assert.equal(await layered.delete("1-projects/a.md", { onlyIf: { etagMatches: "stale" } }), null);
  assert.ok(store.objects.has(KEY));
  assert.ok(!cp.calls.some(([name]) => name === "removed"));
});

test("deleting where there is no note does nothing", async () => {
  const store = bucket();
  await store.put("1-projects/stray.md", "x");
  const layered = withIdLayout(store, controlPlaneOver({}).hooks);
  await layered.delete("1-projects/stray.md");
  assert.ok(store.objects.has("1-projects/stray.md"));
});

/* -------------------------------- copies ------------------------------- */

test("copying a keyed note creates a new note with an id of its own", async () => {
  const { store, cp, layered } = await keyedNote();
  await layered.copy("1-projects/a.md", "1-projects/b.md");
  const adopt = cp.calls.find(([name]) => name === "adopt")[1];
  assert.equal(adopt.path, "1-projects/b.md");
  assert.notEqual(adopt.key, KEY);
  assert.equal(store.objects.get(adopt.key).body, "KEY BODY");
  assert.ok(!store.log.some(([op]) => op === "copy"));
});

/* ------------------------------- wiring -------------------------------- */

test("the keys layout is refused without the hooks that create and retire rows", () => {
  const cp = controlPlaneOver({});
  assert.throws(() => withIdLayout(bucket(), { ...cp.hooks, adopt: undefined }), /adopt and removed/);
});

const BINDING = {
  workspaceId: "w1",
  status: "active",
  provider: "r2-binding",
  bindingName: "TEST_BUCKET",
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
};

test("a session in the keys layout creates notes at id keys, beneath the note cap", async () => {
  const bucketFake = bucket();
  const adopted = [];
  const controlPlane = {
    getStorageBinding: async () => ({ binding: BINDING, pendingMoves: [], idLayout: "keys" }),
    noteIdLookup: async () => ({ copies: {}, keyed: true, notes: {} }),
    noteIdWrote: async () => ({ recorded: true }),
    noteIdAdopt: async (token, workspaceId, note) => {
      adopted.push([token, workspaceId, note.path]);
      return { adopted: true, taken: null };
    },
    noteIdRemoved: async () => ({ removed: true }),
  };
  const session = { workspaceId: "w1", accessToken: "tok" };
  const built = await storeForSession(session, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucketFake }, controlPlane);
  await built.put("1-projects/new.md", "HELLO", { onlyIf: { absent: true } });
  assert.deepEqual(adopted, [["tok", "w1", "1-projects/new.md"]]);
  assert.ok([...bucketFake.objects.keys()].every((key) => isIdKey(key)));
});

test("a session in the keys layout with a control plane that cannot adopt is refused, never served paths", async () => {
  const controlPlane = {
    getStorageBinding: async () => ({ binding: BINDING, pendingMoves: [], idLayout: "keys" }),
    noteIdLookup: async () => ({ copies: {} }),
    noteIdWrote: async () => ({ recorded: true }),
  };
  await assert.rejects(
    storeForSession({ workspaceId: "w1", accessToken: "tok" }, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucket() }, controlPlane),
    /adopts notes/,
  );
});

/* ------------------------------- client -------------------------------- */

function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const ENV = { CONTROL_PLANE_URL: "https://cp.example/", GATEWAY_SECRET: "secret" };

test("getStorageBinding reads the keys layout", async () => {
  const cp = createControlPlane(ENV, { fetchImpl: recorder({ binding: BINDING, idLayout: "keys" }).fetchImpl });
  assert.equal((await cp.getStorageBinding("tok", "w1")).idLayout, "keys");
});

test("noteIdLookup keeps only well-formed note entries, and says whether the workspace is keyed", async () => {
  const { fetchImpl } = recorder({
    copies: {},
    keyed: true,
    notes: {
      "a.md": { state: "keyed", key: KEY, etag: "k1", noteId: "0192f1a2-3b4c-7d5e-8f60-000000000001", size: 3, legacyEtag: "p1" },
      "b.md": { state: "keyed", key: "1-projects/b.md", etag: "k2" },
      "c.md": { state: "keyed", key: KEY, etag: "" },
      "d.md": { state: "path", key: OTHER_KEY, etag: "p", keyEtag: "k", fresh: true },
      "e.md": { state: "gone" },
      f: { state: "folder" },
      "g.md": { state: "unheard of" },
    },
  });
  const answer = await createControlPlane(ENV, { fetchImpl }).noteIdLookup("tok", "w1", ["a.md"]);
  assert.equal(answer.keyed, true);
  assert.deepEqual(answer.notes, {
    "a.md": { state: "keyed", key: KEY, etag: "k1", noteId: "0192f1a2-3b4c-7d5e-8f60-000000000001", size: 3, legacyEtag: "p1" },
    "d.md": { state: "path", key: OTHER_KEY, etag: "p", keyEtag: "k", fresh: true },
    "e.md": { state: "gone" },
    f: { state: "folder" },
  });
});

test("noteIdAdopt and noteIdRemoved post the note with the session's proofs", async () => {
  const adopting = recorder({ ok: true, adopted: false, taken: { state: "keyed", key: OTHER_KEY, etag: "k" } });
  const cp = createControlPlane(ENV, { fetchImpl: adopting.fetchImpl });
  const note = { path: "a.md", noteId: "0192f1a2-3b4c-7d5e-8f60-000000000001", key: KEY, etag: "k1", size: 2, at: 5 };
  assert.deepEqual(await cp.noteIdAdopt("tok", "w1", note), {
    adopted: false,
    taken: { state: "keyed", key: OTHER_KEY, etag: "k" },
  });
  assert.equal(adopting.calls[0].url, "https://cp.example/gateway/note-ids/adopt");
  assert.deepEqual(adopting.calls[0].body, { workspaceId: "w1", ...note, accessToken: "tok", expectedWorkspaceId: "w1" });

  const removing = recorder({ ok: true, removed: true });
  const removal = createControlPlane(ENV, { fetchImpl: removing.fetchImpl });
  assert.deepEqual(await removal.noteIdRemoved("tok", "w1", { path: "a.md", key: KEY, at: 6 }), { removed: true });
  assert.deepEqual(removing.calls[0].body, {
    workspaceId: "w1",
    path: "a.md",
    key: KEY,
    at: 6,
    accessToken: "tok",
    expectedWorkspaceId: "w1",
  });
});
