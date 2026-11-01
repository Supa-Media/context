/**
 * A NOTE READ IS TWO CALLS, ONE AFTER THE OTHER (2026-11-01).
 *
 * Before: a plain keyed note took seven calls in a row: the tree lookup for
 * the probe, the probe, the same lookup again for the body, the body, the
 * same lookup a third time for the collaboration engine's note id, then the
 * head filed by id and, missing that, the head filed by path. Each waited for
 * the one before it.
 *
 * Now the read asks the tree once (`oneRead`, `store/idLayout.js`); that
 * answer says whether the note is there, where its bytes are and which id its
 * head is filed under. Then the body and both collaboration heads are read
 * side by side. "Steps" below counts calls that had to wait for another: a
 * call's step is one more than the latest step that finished before it
 * started.
 *
 * Refusals cost the same whatever the reason (`toolReadNote` argues why):
 * held back, missing, or both, each is the lookup and then the forwarding
 * read, and the bucket never sees the note's key.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-11-01).
 *
 *  1. `oneRead` built with the plain `lookup` instead of `rememberingLookup`.
 *     → "a plain note is read in two steps…" fails (3 lookups, 5 steps).
 *  2. `startedDocument` returning null (heads read after the body again).
 *     → "a plain note is read in two steps…" fails (3 steps).
 *  3. `notePresent` probing the bucket even with the id layer.
 *     → "every refusal costs the same…" fails (the held-back note's key is
 *       probed, the missing one's is not).
 *  4. `readHead` without `pathHeadTogether` from `readDocumentIfStarted`.
 *     → "a plain note is read in two steps…" fails (3 steps).
 *  5. `prime` not called by `read_notes`.
 *     → "read_notes looks every path up in one lookup…" fails.
 *  6. `carriesUntrustedFrontmatter` reading only the first part.
 *     → "a read_notes answer marks the turn untrusted…" fails.
 *  7. `readsCapturedContent` without its `read_notes` line.
 *     → "a read_notes call naming a meeting note…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withIdLayout } from "../src/store/idLayout.js";
import { idKeyFor } from "../src/store/noteIdKeys.js";
import { toolReadNote, toolReadNotes } from "../src/tools/notes/read.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { recordRead, newLedger } from "../src/privacy/egress.js";

const ids = {
  plain: "0190a000-0000-7000-8000-0000000000a1",
  held: "0190a000-0000-7000-8000-0000000000a2",
  other: "0190a000-0000-7000-8000-0000000000a3",
};
const PATHS = { plain: "1-projects/plain.md", held: "1-projects/held.md", other: "1-projects/other.md" };

/** A bucket and a tree that log every call with the step it ran at. */
function world() {
  const log = [];
  let finished = 0;
  const call = async (kind, detail, answer) => {
    const entry = { kind, detail, step: finished + 1 };
    log.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 1));
    finished = Math.max(finished, entry.step);
    return answer();
  };
  const objects = new Map();
  const put = (key, body) => objects.set(key, { body, etag: `etag-${objects.size}` });
  for (const name of Object.keys(ids)) put(idKeyFor(ids[name], PATHS[name]), `# ${name}\n\nThe ${name} note.\n`);
  const object = (key) => {
    const held = objects.get(key);
    return held ? { key, etag: held.etag, size: held.body.length, text: async () => held.body, arrayBuffer: async () => new TextEncoder().encode(held.body).buffer } : null;
  };
  const bucket = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    get: (key) => call("get", key, () => object(key)),
    head: (key) => call("head", key, () => object(key)),
    existsMetadata: (key) => call("existsMetadata", key, () => objects.has(key)),
    put: (key, body) => call("put", key, () => (put(key, String(body)), { etag: objects.get(key).etag })),
    delete: (key) => call("delete", key, () => objects.delete(key)),
    list: async () => ({ objects: [], truncated: false }),
  };
  const rows = Object.fromEntries(
    Object.keys(ids).map((name) => [PATHS[name], { state: "keyed", key: idKeyFor(ids[name], PATHS[name]), etag: objects.get(idKeyFor(ids[name], PATHS[name])).etag, noteId: ids[name] }]),
  );
  const store = withIdLayout(bucket, {
    lookup: (paths) =>
      call("lookup", paths.join(","), () => ({ keyed: true, notes: Object.fromEntries(paths.filter((path) => rows[path]).map((path) => [path, rows[path]])), texHomes: {} })),
    wrote: async () => ({ recorded: true }),
    adopt: async () => ({ adopted: true, taken: null }),
    removed: async () => ({ removed: true }),
  });
  const reset = () => {
    log.length = 0;
    finished = 0;
  };
  return { store, log, reset };
}

/** The rows as a reader is judged by them: projects for the team, one note there held back, the archive private. */
async function privacy() {
  const overrides = new PrivacyOverrides();
  overrides.set("1-projects/held.md", "private");
  return { rules: [{ prefix: "1-projects", vis: "team" }, { prefix: "4-archive", vis: "private" }], overrides };
}

const steps = (log) => Math.max(0, ...log.map((entry) => entry.step));

test("a plain note is read in two steps: one lookup, then its body beside its collaboration heads", async () => {
  const { rules, overrides } = await privacy();
  const { store, log, reset } = world();
  reset();
  const result = await toolReadNote(store, "private", rules, overrides, PATHS.plain);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /The plain note\./);
  assert.equal(log.filter((entry) => entry.kind === "lookup").length, 1, JSON.stringify(log));
  assert.equal(steps(log), 2, JSON.stringify(log));
  // The second step is the body and the two head reads, and nothing else.
  const second = log.filter((entry) => entry.step === 2).map((entry) => entry.kind);
  assert.deepEqual(second.sort(), ["get", "get", "get"], JSON.stringify(log));
  assert.ok(log.some((entry) => entry.detail === idKeyFor(ids.plain, PATHS.plain)));
});

test("every refusal costs the same: held back, missing, or held back and missing", async () => {
  const { rules, overrides } = await privacy();
  const shapes = [];
  for (const path of [PATHS.held, "1-projects/never.md", "4-archive/never.md"]) {
    const { store, log, reset } = world();
    reset();
    const result = await toolReadNote(store, "team", rules, overrides, path);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "not found");
    // The bucket never sees a note's key on a refusal: only the forwarding table is read.
    assert.ok(!log.some((entry) => entry.detail.startsWith("notes/")), JSON.stringify(log));
    shapes.push(JSON.stringify(log.map(({ kind, step }) => [kind, step])));
  }
  assert.equal(new Set(shapes).size, 1, shapes.join("\n"));
});

test("read_notes looks every path up in one lookup, and reads the notes side by side", async () => {
  const { rules, overrides } = await privacy();
  const { store, log, reset } = world();
  reset();
  const result = await toolReadNotes(store, "team", rules, overrides, [PATHS.plain, PATHS.other, PATHS.held, "1-projects/never.md"]);
  assert.equal(result.isError, undefined, JSON.stringify(result) + JSON.stringify(log));
  assert.equal(result.content.length, 4);
  assert.match(result.content[0].text, /^etag: .*\npath: 1-projects\/plain\.md\n[\s\S]*The plain note\./);
  assert.match(result.content[1].text, /The other note\./);
  // Held back and missing read the same.
  assert.equal(result.content[2].text, "path: 1-projects/held.md\nerror: not found");
  assert.equal(result.content[3].text, "path: 1-projects/never.md\nerror: not found");
  // The activity log is told of the two notes opened, never of the refused ones.
  assert.deepEqual(result.notesRead, [PATHS.plain, PATHS.other]);
  assert.equal(Object.keys(result).includes("notesRead"), false);
  assert.equal(log.filter((entry) => entry.kind === "lookup").length, 1, JSON.stringify(log));
  assert.ok(!log.some((entry) => entry.detail === idKeyFor(ids.held, PATHS.held)), "the held-back note's bytes are never read");
  assert.equal(steps(log), 2, JSON.stringify(log));
});

test("read_notes refuses an empty list, a list too long, and anything but strings", async () => {
  const { rules, overrides } = await privacy();
  const { store } = world();
  assert.equal((await toolReadNotes(store, "private", rules, overrides, [])).isError, true);
  assert.equal((await toolReadNotes(store, "private", rules, overrides, Array.from({ length: 26 }, (_, i) => `n${i}.md`))).isError, true);
  assert.equal((await toolReadNotes(store, "private", rules, overrides, [PATHS.plain, 7])).isError, true);
});

test("read_notes answers isError only when no note could be read", async () => {
  const { rules, overrides } = await privacy();
  const { store } = world();
  const result = await toolReadNotes(store, "team", rules, overrides, [PATHS.held, "1-projects/never.md"]);
  assert.equal(result.isError, true);
});

test("a read_notes answer marks the turn untrusted when any note in it is a stranger's, not only the first", async () => {
  const ledger = newLedger();
  recordRead(ledger, {
    name: "read_notes",
    args: { paths: ["1-projects/a.md", "1-projects/b.md"] },
    result: { content: [{ type: "text", text: "etag: e\npath: 1-projects/a.md\n\n# A" }, { type: "text", text: "etag: e\npath: 1-projects/b.md\n\n---\ntrust: untrusted\n---\n# B" }] },
  });
  assert.equal(ledger.untrusted, true);
});

test("a read_notes call naming a meeting note marks the turn untrusted, as read_note does", async () => {
  const MEETING = "inbox/meetings/2026-11-01-standup.md";
  const plain = newLedger();
  recordRead(plain, { name: "read_notes", args: { paths: ["1-projects/a.md"] }, result: { content: [{ type: "text", text: "# A" }] } });
  assert.equal(plain.untrusted, false);
  const single = newLedger();
  recordRead(single, { name: "read_note", args: { path: MEETING }, result: { content: [{ type: "text", text: "# Standup" }] } });
  assert.equal(single.untrusted, true);
  const many = newLedger();
  recordRead(many, { name: "read_notes", args: { paths: ["1-projects/a.md", MEETING] }, result: { content: [{ type: "text", text: "# A" }] } });
  assert.equal(many.untrusted, true);
});
