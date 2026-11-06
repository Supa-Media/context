// A save keeps no revision file of its own (`versions.js`): the state carries the current snapshot, a marker finds a
// recent revision again as a merge base, and a version file is kept only when the person goes idle five minutes.
//
// Sabotage record (applied, test run, named test observed failing, reverted; 2026-11-04):
//  1. `commitSnapshot` writing its revision file again.
//     → "a save writes the Markdown and the document state, and nothing else" fails.
//  2. `markedRevision` skipping its hash check.
//     → "a marker whose rebuilt text does not match is never used" fails (a wrong base is merged against).
//  3. `idleSince` answering false.
//     → "a save after five idle minutes keeps the state the person stopped at as a version" fails.
//  4. `keepIdleVersion` letting its error through.
//     → "a version that cannot be kept never fails the save" fails.
import assert from "node:assert/strict";
import test from "node:test";
import { readDocument, replaceText } from "../src/index.js";
import { BASE_MARKERS, IDLE_MS } from "../src/versions.js";

const PATH = "1-projects/note.md";

class MemoryStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.sequence = 0;
    this.puts = [];
    this.gets = [];
    this.refuse = () => false;
  }
  async get(key) {
    this.gets.push(key);
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }
  async put(key, value, options = {}) {
    if (this.refuse(key)) throw new Error("injected put failure");
    this.puts.push(key);
    const current = this.objects.get(key);
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    if (options.onlyIf?.absent && current) return null;
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
    return { etag };
  }
  async delete(key) {
    for (const one of Array.isArray(key) ? key : [key]) this.objects.delete(one);
  }
  async list({ prefix = "" } = {}) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: this.objects.get(key).etag })), truncated: false };
  }
  revisionFiles() {
    return [...this.objects.keys()].filter((key) => key.includes("/revisions/"));
  }
}

/** Run `work` with `Date.now` answering `at`. */
async function at(time, work) {
  const real = Date.now;
  Date.now = () => time;
  try {
    return await work();
  } finally {
    Date.now = real;
  }
}

async function started() {
  const store = new MemoryStore();
  await store.put(PATH, "# Note\n\nWe ship on Friday.\n");
  const first = await readDocument(store, PATH);
  return { store, first };
}

const save = (store, etag, text, extra = {}) => replaceText(store, PATH, { expectedEtag: etag, onlyCurrent: true, text, ...extra });

test("a save writes the Markdown and the document state, and nothing else", async () => {
  const { store, first } = await started();
  const before = store.revisionFiles();
  store.puts = [];
  await save(store, first.etag, "# Note\n\nWe ship on Monday.\n");
  assert.deepEqual(store.revisionFiles(), before);
  assert.ok(store.puts.every((key) => key === PATH || (key.includes("/documents/") && !key.includes("/operations/"))), store.puts.join("\n"));
});

test("an older version a client holds still merges, rebuilt from its marker, with no file read", async () => {
  const { store, first } = await started();
  const second = await save(store, first.etag, "# Note\n\nWe ship on Monday.\n");
  await save(store, second.etag, "# Note\n\nWe ship on Monday.\n\nThanks, team.\n");
  store.gets = [];
  // An editor that read the second version changes the title, against that base: the newer line is kept.
  const merged = await replaceText(store, PATH, { expectedEtag: second.etag, text: "# Plan\n\nWe ship on Monday.\n" });
  assert.equal(merged.text, "# Plan\n\nWe ship on Monday.\n\nThanks, team.\n");
  assert.deepEqual(store.gets.filter((key) => key.includes("/revisions/")), []);
});

test("a marker whose rebuilt text does not match is never used", async () => {
  const { store, first } = await started();
  const second = await save(store, first.etag, "# Note\n\nWe ship on Monday.\n");
  await save(store, second.etag, "# Note\n\nWe ship on Tuesday.\n");
  const key = [...store.objects.keys()].find((name) => name.includes("/documents/") && !name.includes("/operations/"));
  const state = JSON.parse(store.objects.get(key).text);
  const revision = second.etag.split(".").at(-1);
  state.bases = state.bases.map((entry) => (entry.revision === revision ? { ...entry, hash: "00000000" } : entry));
  store.objects.set(key, { ...store.objects.get(key), text: JSON.stringify(state) });
  await assert.rejects(() => replaceText(store, PATH, { expectedEtag: second.etag, text: "# Plan\n\nWe ship on Monday.\n" }), (error) => error.code === "BASE_MISSING");
});

test("a state keeps markers for its most recent revisions only", async () => {
  const { store, first } = await started();
  let etag = first.etag;
  for (let index = 0; index < BASE_MARKERS + 4; index += 1) etag = (await save(store, etag, `# Note\n\nSave ${index}.\n`)).etag;
  const key = [...store.objects.keys()].find((name) => name.includes("/documents/") && !name.includes("/operations/"));
  const state = JSON.parse(store.objects.get(key).text);
  assert.equal(state.bases.length, BASE_MARKERS);
  assert.equal(state.bases.at(-1).revision, etag.split(".").at(-1));
});

test("a save after five idle minutes keeps the state the person stopped at as a version", async () => {
  const { store, first } = await started();
  const start = 1_800_000_000_000;
  const stopped = await at(start, () => save(store, first.etag, "# Note\n\nWe ship on Monday.\n"));
  const soon = await at(start + 60_000, () => save(store, stopped.etag, "# Note\n\nWe ship on Tuesday.\n"));
  const kept = (etag) => store.objects.has(`.context/collaboration/v1/revisions/${etag.split(".")[1]}/${etag.split(".").at(-1)}.json`);
  assert.equal(kept(stopped.etag), false, "a save a minute later kept a version");
  await at(start + 60_000 + IDLE_MS, () => save(store, soon.etag, "# Note\n\nWe ship on Wednesday.\n"));
  assert.equal(kept(soon.etag), true, "the state before five idle minutes was not kept");
  const version = JSON.parse(store.objects.get(`.context/collaboration/v1/revisions/${soon.etag.split(".")[1]}/${soon.etag.split(".").at(-1)}.json`).text);
  assert.equal(version.text, "# Note\n\nWe ship on Tuesday.\n");
});

test("a version that cannot be kept never fails the save", async () => {
  const { store, first } = await started();
  const start = 1_800_000_000_000;
  const stopped = await at(start, () => save(store, first.etag, "# Note\n\nWe ship on Monday.\n"));
  store.refuse = (key) => key.includes("/revisions/");
  const later = await at(start + IDLE_MS, () => save(store, stopped.etag, "# Note\n\nWe ship on Tuesday.\n"));
  assert.equal(later.text, "# Note\n\nWe ship on Tuesday.\n");
  assert.equal(store.objects.get(PATH).text, "# Note\n\nWe ship on Tuesday.\n");
});
