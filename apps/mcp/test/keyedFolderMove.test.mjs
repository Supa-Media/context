/**
 * `move_folder` in a keyed workspace (`tools/moves/keyedFolder.js`): the folder
 * moves as rows in the control plane, every nested folder and note kept as
 * itself, never copied or flattened by path; a dry run answers from the tree;
 * and the links to and inside the moved notes follow them.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - put the old keyed refusal back in `toolMoveFolder`: every case here is refused;
 *  - let a keyed real move fall through to the move in one go: the declined case writes bytes;
 *  - drop the hidden-note check from the dry run: the preflight says ok to a move the control plane refuses;
 *  - drop `rewriteRowedLinks` from the folder answer: the link cases keep their old targets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolMoveFolder } from "../src/tools/moves/folder.js";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { KEYED_PATH_REFUSAL } from "../src/store/idLayout.js";
import { withServedTree } from "./servedTree.mjs";

/** A bucket fake that is also the tree: its keys are the notes' names, as the id layer routes them. */
function workspace(files) {
  const objects = new Map(Object.entries(files).map(([key, body]) => [key, { body, etag: `v-${key}` }]));
  const writes = [];
  let counter = 0;
  const store = {
    keyedLayout: true,
    // Without conditional delete a rewrite writes a note's text, with no collaboration document to open.
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async keyedWorkspace() {
      return true;
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { etag: value.etag, size: value.body.length } : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        etag: value.etag,
        httpMetadata: {},
        text: async () => value.body,
        arrayBuffer: async () => new TextEncoder().encode(value.body).buffer,
      };
    },
    async put(key, body, options = {}) {
      writes.push(["put", key]);
      if (options.onlyIf?.absent && objects.has(key)) return null;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      const etag = `e${++counter}`;
      objects.set(key, { body: text, etag });
      return { etag };
    },
    async delete(key) {
      writes.push(["delete", key]);
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key, etag: objects.get(key).etag, size: 1 })), truncated: false };
    },
  };
  return { store: withServedTree(store), objects, writes };
}

/** The writes that touch note bytes: not the activity record. */
const noteWrites = (writes) => writes.filter(([, key]) => !key.startsWith(".context/") && key !== "activity.md");

/**
 * A control plane that moves the rows as `rowMoveStart.ts` does: each name under the folder renamed,
 * the same bytes (the same id) at the new name, and the moved files named in the answer.
 */
function rowMovingControlPlane(made) {
  const asked = [];
  made.store.startQueuedMove = async (from, to, expectedEtag) => {
    asked.push({ from, to, expectedEtag });
    const moved = [];
    for (const key of [...made.objects.keys()].sort()) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      const next = `${to}${key.slice(from.length)}`;
      made.objects.set(next, made.objects.get(key));
      made.objects.delete(key);
      moved.push({ from: key, to: next });
    }
    return { queued: true, count: moved.length, rowed: true, moved };
  };
  return asked;
}

const PROJECT = {
  "1-projects/context-ci-cd/index.md": "# CI/CD\n\nSee [the first run](runs/2026-10-01.md) and [[speed-plan]].\n",
  "1-projects/context-ci-cd/runs/2026-10-01.md": "# Run\n\nBack to [the project](../index.md); house rules in [rules](../../../4-resources/rules.md).\n",
  "1-projects/context-ci-cd/decisions/speed-plan.md": "# Speed plan\n",
  "1-projects/context-ci-cd/decisions/caching/cache.md": "# Cache\n",
  "4-resources/rules.md": "# Rules\n",
  "2-areas/status.md": "# Status\n\nCI work: [CI/CD](../1-projects/context-ci-cd/index.md).\n",
};

const SOURCE = "1-projects/context-ci-cd";
const ARCHIVED = "5-archive/1-projects/context-ci-cd";

test("a keyed folder moves as rows: every nested folder and note arrives as itself, and no bytes are copied", async () => {
  const made = workspace(PROJECT);
  const asked = rowMovingControlPlane(made);
  const bodies = Object.fromEntries([...made.objects].map(([key, value]) => [key, value.etag]));

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), `${SOURCE}/`, `${ARCHIVED}/`, false);

  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.match(answer.content[0].text, /moved folder: 1-projects\/context-ci-cd\/ → 5-archive\/1-projects\/context-ci-cd\/ \(4 objects\)/);
  assert.deepEqual(asked, [{ from: SOURCE, to: ARCHIVED, expectedEtag: undefined }]);
  // The shape is kept, nothing is flattened, and nothing is left at the old name.
  for (const key of Object.keys(PROJECT).filter((key) => key.startsWith(`${SOURCE}/`))) {
    const landed = `${ARCHIVED}${key.slice(SOURCE.length)}`;
    assert.ok(made.objects.has(landed), landed);
    assert.ok(!made.objects.has(key), key);
  }
  assert.ok(!made.objects.has("5-archive/cache.md") && !made.objects.has("5-archive/speed-plan.md"));
  // The note that holds no link is the very object it was: the same version, so the same note.
  assert.equal(made.objects.get(`${ARCHIVED}/decisions/caching/cache.md`).etag, bodies[`${SOURCE}/decisions/caching/cache.md`]);
  // The only bytes written are link repairs, never a copy of a moved note.
  for (const [op, key] of noteWrites(made.writes)) {
    assert.equal(op, "put");
    assert.ok(!key.startsWith(`${SOURCE}/`), key);
  }
});

test("links to the moved notes and relative links inside them follow the folder", async () => {
  const made = workspace(PROJECT);
  rowMovingControlPlane(made);

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, false);

  assert.match(answer.content[0].text, /references: \d+ links? updated in \d+ notes?/);
  // A note outside points at the new name.
  assert.match(made.objects.get("2-areas/status.md").body, /\(\.\.\/5-archive\/1-projects\/context-ci-cd\/index\.md\)/);
  // A link out of the moved folder needs one more `../`; a link inside it is unchanged.
  const run = made.objects.get(`${ARCHIVED}/runs/2026-10-01.md`).body;
  assert.match(run, /\(\.\.\/index\.md\)/);
  assert.match(run, /\(\.\.\/\.\.\/\.\.\/\.\.\/4-resources\/rules\.md\)/);
  assert.match(made.objects.get(`${ARCHIVED}/index.md`).body, /\(runs\/2026-10-01\.md\) and \[\[speed-plan\]\]/);
});

test("a keyed note move updates the links to it too", async () => {
  const made = workspace(PROJECT);
  rowMovingControlPlane(made);

  const answer = await toolMoveNote(made.store, "private", [], new Map(), `${SOURCE}/index.md`, "2-areas/ci-cd.md", undefined);

  assert.match(answer.content[0].text, /moved note: .* → 2-areas\/ci-cd\.md\nreferences: /);
  assert.match(made.objects.get("2-areas/status.md").body, /\(\.\/ci-cd\.md\)/);
});

test("a keyed dry run lists every note where it will land, from the tree, and moves nothing", async () => {
  const made = workspace(PROJECT);
  const asked = rowMovingControlPlane(made);

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, true);
  const text = answer.content[0].text;

  assert.match(text, /^preflight ok: folder 1-projects\/context-ci-cd\/ → 5-archive\/1-projects\/context-ci-cd\/ \(4 objects: 4 notes in 4 folders\)/);
  assert.match(text, /same note ids, content and sharing, every nested folder kept, nothing copied/);
  assert.match(text, /- 1-projects\/context-ci-cd\/decisions\/caching\/cache\.md → 5-archive\/1-projects\/context-ci-cd\/decisions\/caching\/cache\.md \[private\]/);
  assert.deepEqual(asked, []);
  assert.deepEqual(noteWrites(made.writes), []);
  assert.ok(made.objects.has(`${SOURCE}/index.md`));
});

test("a keyed dry run refuses a folder holding something the caller cannot see, as the move would, naming nothing", async () => {
  const made = workspace({ ...PROJECT, "1-projects/context-ci-cd/secret/plan.md": "# Hidden\n" });
  rowMovingControlPlane(made);
  const rules = [
    { prefix: "1-projects", vis: "team" },
    { prefix: "2-areas", vis: "team" },
    { prefix: "1-projects/context-ci-cd/secret", vis: "private" },
  ];

  const answer = await toolMoveFolder(made.store, "team", rules, new Map(), SOURCE, "2-areas/context-ci-cd", true);

  assert.equal(answer.isError, true);
  assert.equal(answer.content[0].text, "conflict: That folder cannot move in one step.");
  assert.doesNotMatch(answer.content[0].text, /secret/);
});

test("a keyed dry run of a folder the caller cannot see at all is not found", async () => {
  const made = workspace(PROJECT);
  rowMovingControlPlane(made);
  const rules = [{ prefix: "1-projects/context-ci-cd", vis: "private" }];

  const answer = await toolMoveFolder(made.store, "team", rules, new Map(), SOURCE, "2-areas/context-ci-cd", true);

  assert.equal(answer.content[0].text, "not found");
});

test("a keyed dry run refuses a destination the tree already has", async () => {
  const made = workspace({ ...PROJECT, [`${ARCHIVED}/index.md`]: "# Older copy\n" });
  rowMovingControlPlane(made);

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, true);

  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /^conflict: destination already exists: 5-archive\/1-projects\/context-ci-cd\/index\.md/);
});

test("a keyed move the control plane declines moves nothing the old way", async () => {
  const made = workspace(PROJECT);
  made.store.startQueuedMove = async () => ({ queued: false });

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, false);

  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /could not move that folder right now\. Nothing was changed/);
  assert.deepEqual(noteWrites(made.writes), []);
  assert.ok(made.objects.has(`${SOURCE}/index.md`) && !made.objects.has(`${ARCHIVED}/index.md`));
});

test("a keyed move the control plane refuses says why, and moves nothing", async () => {
  const made = workspace(PROJECT);
  made.store.startQueuedMove = async () => ({ queued: false, error: "CONFLICT", message: "That folder cannot move in one step." });

  const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, false);

  assert.equal(answer.content[0].text, "conflict: That folder cannot move in one step.");
  assert.deepEqual(noteWrites(made.writes), []);
});

test("a keyed workspace with no control plane to ask still refuses, dry run included, before anything moves", async () => {
  for (const dryRun of [false, true]) {
    const made = workspace(PROJECT);

    const answer = await toolMoveFolder(made.store, "private", [], new Map(), SOURCE, ARCHIVED, dryRun);

    assert.equal(answer.content[0].text, KEYED_PATH_REFUSAL);
    assert.deepEqual(noteWrites(made.writes), []);
  }
});
