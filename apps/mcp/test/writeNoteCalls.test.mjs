/**
 * A SAVE LOOKS ITS NOTE'S ROW UP ONCE (2026-11-03).
 *
 * Before: one `write_note` to an existing note asked the workspace object for
 * the same path's row three times in a row: the find, the load, and the save
 * itself (production `mcp_entry`: `obj:ws.rows.lookup` ×3 per save). Each
 * waited for the one before it.
 *
 * Now the write tool works through a write view (`oneWrite`,
 * `store/idLayout.js`): the row is looked up once and that answer serves the
 * reads and the save. The save still goes through every layer above the id
 * layer (the note cap, the read-only rows), carrying the remembered lookup
 * beside its options, and the path is forgotten once written, so a read after
 * the save asks again.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-11-03).
 *
 *  1. `toolWriteNote` using the store it was handed instead of `oneWrite`.
 *     → "an edit to an existing note looks its row up once…" fails.
 *  2. `oneWrite`'s put calling the id layer's put directly, skipping `outer`.
 *     → "the note cap still judges a create made through the write view" fails.
 *  3. `ask.forget` removed from the view's put.
 *     → "a read through the view after its save asks the tree again" fails.
 *  4. `remembered` not taking `REMEMBERED` off the options.
 *     → "the bucket never sees the remembered lookup in a put's options" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withIdLayout } from "../src/store/idLayout.js";
import { withNoteCap, NoteCapReached } from "../src/store/noteCap.js";
import { idKeyFor } from "../src/store/noteIdKeys.js";
import { toolWriteNote } from "../src/tools/notes/write.js";

const NOTE_ID = "0190a000-0000-7000-8000-0000000000b1";
const PATH = "1-projects/plain.md";
const KEY = idKeyFor(NOTE_ID, PATH);

function world() {
  const log = [];
  const objects = new Map([[KEY, { body: "# Plain\n\nThe plain note.\n", etag: "etag-0" }]]);
  let version = 0;
  const object = (key) => {
    const held = objects.get(key);
    return held
      ? { key, etag: held.etag, size: held.body.length, text: async () => held.body, arrayBuffer: async () => new TextEncoder().encode(held.body).buffer }
      : null;
  };
  const putOptions = [];
  const bucket = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    get: async (key) => (log.push({ kind: "get", key }), object(key)),
    head: async (key) => (log.push({ kind: "head", key }), object(key)),
    exists: async (key) => (log.push({ kind: "exists", key }), objects.has(key)),
    existsMetadata: async (key) => (log.push({ kind: "existsMetadata", key }), objects.has(key)),
    put: async (key, body, options) => {
      log.push({ kind: "put", key });
      putOptions.push(options);
      const held = objects.get(key);
      if (options?.onlyIf?.absent === true && held) return null;
      if (typeof options?.onlyIf?.etagMatches === "string" && held?.etag !== options.onlyIf.etagMatches) return null;
      version += 1;
      objects.set(key, { body: String(body), etag: `etag-${version}` });
      return { etag: `etag-${version}` };
    },
    delete: async (key) => (log.push({ kind: "delete", key }), objects.delete(key)),
    list: async () => ({ objects: [], truncated: false }),
    // The names the tree holds: the write's find and its name-twin check.
    treeManifest: async () => ({ served: true, entries: [{ path: PATH, etag: "etag-0", size: 1, updatedAt: 1 }], cursor: null }),
    // A new note's tier goes on its row.
    rowAccess: { setTier: async () => ({ ok: true }), addPeople: async () => ({ ok: true }) },
    treeFacts: async ({ paths }) => ({ served: true, files: paths.filter((path) => path === PATH), folders: [] }),
  };
  const rows = { [PATH]: { state: "keyed", key: KEY, etag: "etag-0", noteId: NOTE_ID } };
  const store = withIdLayout(bucket, {
    lookup: async (paths) => {
      log.push({ kind: "lookup", key: paths.join(",") });
      return { keyed: true, notes: Object.fromEntries(paths.filter((path) => rows[path]).map((path) => [path, { ...rows[path] }])), texHomes: {} };
    },
    wrote: async (record) => {
      rows[record.path] = { ...rows[record.path], etag: record.etag };
      return { recorded: true };
    },
    adopt: async (record) => {
      rows[record.path] = { state: "keyed", key: record.key, etag: record.etag, noteId: record.noteId };
      return { adopted: true, taken: null };
    },
    removed: async () => ({ removed: true }),
  });
  return { store, log, objects, putOptions };
}

const RULES = [{ prefix: "1-projects", vis: "team" }];
const lookups = (log) => log.filter((entry) => entry.kind === "lookup" && entry.key === PATH).length;

test("a new note looks its path up once", async () => {
  const { store, log, objects } = world();
  const NEW = "1-projects/new.md";
  const result = await toolWriteNote(store, "team", RULES, undefined, { path: NEW, content: "# New\n\nMade.\n" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok([...objects.keys()].some((key) => key !== KEY && key.startsWith("notes/")), [...objects.keys()].join(","));
  // Up to the save, one lookup. The search index reads the new note back after the answer (asked afresh, as the
  // save forgot the path).
  const saved = log.findIndex((entry) => entry.kind === "put" && entry.key.startsWith("notes/"));
  assert.equal(log.slice(0, saved).filter((entry) => entry.kind === "lookup" && entry.key === NEW).length, 1, JSON.stringify(log));
});

test("an edit to an existing note looks its row up once, and a stale etag is still refused", async () => {
  const { store, log, objects } = world();
  const ok = await toolWriteNote(store, "private", RULES, undefined, { path: PATH, content: "# Plain\n\nOne.\n", expected_etag: "etag-0" });
  assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
  assert.equal(lookups(log), 1, JSON.stringify(log));
  const stale = await toolWriteNote(store, "private", RULES, undefined, { path: PATH, content: "# Plain\n\nTwo.\n", expected_etag: "etag-0" });
  assert.equal(stale.isError, true);
  assert.match(objects.get(KEY).body, /One\./);
});

test("a read through the view after its save asks the tree again", async () => {
  const { store, log } = world();
  const view = store.oneWrite(store);
  assert.ok(await view.get(PATH));
  await view.put(PATH, "# Plain\n\nAgain.\n");
  const before = lookups(log);
  const after = await view.get(PATH);
  assert.match(await after.text(), /Again\./);
  assert.equal(lookups(log), before + 1, JSON.stringify(log));
});

test("the bucket never sees the remembered lookup in a put's options", async () => {
  const { store, putOptions } = world();
  const view = store.oneWrite(store);
  await view.get(PATH);
  await view.put(PATH, "# Plain\n\nThree.\n", { onlyIf: { etagMatches: "etag-0" } });
  await view.put("1-projects/new.md", "# New\n");
  assert.equal(putOptions.length, 2);
  for (const options of putOptions) assert.equal(Object.getOwnPropertySymbols(options ?? {}).length, 0);
});

test("the note cap still judges a create made through the write view", async () => {
  const { store, objects } = world();
  const capped = withNoteCap(store, 1, async () => 1);
  await assert.rejects(() => toolWriteNote(capped, "team", RULES, undefined, { path: "1-projects/new.md", content: "# New\n" }), NoteCapReached);
  assert.equal([...objects.keys()].length, 1);
  const view = capped.oneWrite(capped);
  await assert.rejects(() => view.put("1-projects/other.md", "# Other\n", { onlyIf: { absent: true } }), NoteCapReached);
});

test("a new note's row, its name and its twin check are asked side by side, not one after another", async () => {
  const { store } = world();
  const events = [];
  const slow = (name, run) => async (...args) => {
    events.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${name}`);
    return await run(...args);
  };
  // The three questions a create asks before it writes, each a trip to the workspace object in production.
  const lookupOf = store.oneWrite;
  store.treeFacts = slow("names", store.treeFacts);
  store.treeManifest = slow("twins", store.treeManifest);
  store.oneWrite = (outer) => {
    const view = lookupOf(outer);
    const warm = view.warm;
    Object.defineProperty(view, "warm", { value: (path) => (events.push("start:lookup"), warm(path)) });
    return view;
  };
  const result = await toolWriteNote(store, "private", RULES, undefined, { path: "1-projects/new.md", content: "# New\n", visibility: "team", confirm_team_publish: true });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const firstEnd = events.findIndex((event) => event.startsWith("end:"));
  for (const name of ["lookup", "names", "twins"]) {
    const started = events.indexOf(`start:${name}`);
    assert.ok(started !== -1 && started < firstEnd, `${name} waited for another question: ${events.join(", ")}`);
  }
  // A team connection asks them one after another, so a refusal costs what every other refusal costs.
  events.length = 0;
  const team = await toolWriteNote(store, "team", RULES, undefined, { path: "1-projects/other.md", content: "# Other\n" });
  assert.equal(team.isError, undefined, team.content?.[0]?.text);
  assert.ok(!events.includes("start:lookup"), events.join(", "));
});
