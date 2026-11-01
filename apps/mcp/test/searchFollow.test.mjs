/**
 * Fast search follows a move, a removal and a write it was told about, rather
 * than waiting for a sweep to rediscover it (`src/search/d1/follow.js`).
 *
 * Measured on production on 2026-10-13: a note moved with `move_note` was
 * found by search at its OLD path, which no longer opens, and not at its new
 * one, minutes after the move. A ready projection's miss is the answer, and
 * nothing took a moved note's old rows out, so the old name stayed findable
 * until somebody noticed. The end-to-end check below is that sentence, run
 * through the worker against real SQL.
 *
 * Sabotage record (temporary local edits, reverted), as measured:
 *   `indexChangedNotes` not calling `followChangeAfterResponse`   → the
 *     end-to-end check fails exactly as production did: the moved note is
 *     absent at its new path ("2 matching notes", the old path among them)
 *   `folderMoveStatements` renaming only the `notes` table         → 4 fail
 *   `underPattern` not escaping `_`                                → "a folder
 *     named with an underscore moves only its own notes" fails
 *   the tier re-check after a folder rename removed                → "a note
 *     moved into a narrower folder…" and "…change tier with no reads…" fail
 *   same-name note moves sent back to remove-and-project           → the two
 *     "…under the same name…" checks fail on their reads
 *   `tierMoveStatements` deleting without the copy                 → 3 fail:
 *     "…narrower folder…", "…change tier…", "…narrower under the same name…"
 *   the same-basename test dropped (every note move renamed)        → "a moved
 *     note leaves its old path…" and "…a renamed note, are read…" fail
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_ORIGIN,
  DESCRIPTOR,
  DatabaseSync,
  GATEWAY_SECRET,
  PRIVACY_MANIFEST,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createD1Client,
  createS3Backend,
  createWorkerCtx,
  noteStore,
  s3Binding,
  worker,
} from "./searchProjection/fixtures.mjs";
import { followChange, underPattern } from "../src/search/d1/follow.js";
import { projectNote, upsertStatements } from "../src/search/d1/project.js";
import { searchChangeOf } from "../src/activity/record.js";
import { fillSearchDatabase } from "./searchProjection/fill.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const READY = { ...DESCRIPTOR, state: "ready" };
/** `1-projects` is team, everything else private: see `PRIVACY_MANIFEST`. */
const visibilityOf = (path) => (path.startsWith("1-projects/") ? "team" : "private");

async function seedRows(client, notes) {
  for (const [path, content] of Object.entries(notes)) {
    await client.runAll(
      upsertStatements(path, projectNote(path, { version: `old-${path}`, uploaded: null, visibility: visibilityOf(path), content })),
    );
  }
}

function withD1(work) {
  return async () => {
    assert.ok(DatabaseSync, "node:sqlite is available, so the projection is checked against real SQL");
    const d1 = createD1Backend();
    const restore = d1.install();
    try {
      await work(d1, createD1Client(READY));
    } finally {
      restore();
      d1.close();
    }
  };
}

const pathsIn = (d1, table) => d1.rows(`SELECT DISTINCT path FROM ${table} ORDER BY path`).map((row) => row.path);

test(
  "a moved note leaves its old path and is projected at its new one",
  withD1(async (d1, client) => {
    await seedRows(client, { "1-projects/a.md": "# A\n\nquokka\n" });
    const store = noteStore({ "1-projects/b.md": "# B renamed\n\nquokka\n" });
    const result = await followChange(store, client, {
      moved: [["1-projects/a.md", "1-projects/b.md"]],
      visibilityOf,
    });
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/b.md"]);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), ["1-projects/b.md"]);
    assert.equal(d1.rows("SELECT title FROM notes")[0].title, "B renamed");
    assert.equal(result.projected, 1);
    assert.deepEqual(store.reads, ["1-projects/b.md"]);
  }),
);

test(
  "a moved folder's notes are found under the new folder, with no reads",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/old/x.md": "# X\n\nquokka\n",
      "1-projects/old/deep/y.md": "# Y\n\nquokka\n",
      "1-projects/older.md": "# Older\n\nquokka\n",
    });
    const store = noteStore({});
    await followChange(store, client, { moved: [["1-projects/old", "1-projects/new"]], visibilityOf });
    const expected = ["1-projects/new/deep/y.md", "1-projects/new/x.md", "1-projects/older.md"];
    assert.deepEqual(pathsIn(d1, "notes"), expected);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), expected);
    assert.deepEqual(store.reads, []);
    // The version is kept, so the sweep still sees the renamed rows as stale.
    assert.equal(
      d1.rows("SELECT version FROM notes WHERE path = ?", ["1-projects/new/x.md"])[0].version,
      "old-1-projects/old/x.md",
    );
  }),
);

test(
  "a folder named with an underscore moves only its own notes",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/a_b/x.md": "# X\n\nquokka\n",
      "1-projects/aXb/y.md": "# Y\n\nquokka\n",
    });
    await followChange(noteStore({}), client, { moved: [["1-projects/a_b", "1-projects/c"]], visibilityOf });
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/aXb/y.md", "1-projects/c/x.md"]);
    assert.equal(underPattern("a_b%c\\d"), "a\\_b\\%c\\\\d/%");
  }),
);

test(
  "a note moved into a narrower folder leaves the wider tier's table",
  withD1(async (d1, client) => {
    await seedRows(client, { "1-projects/shared/plan.md": "# Plan\n\nquokka\n" });
    const store = noteStore({ "2-areas/shared/plan.md": "# Plan\n\nquokka\n" });
    await followChange(store, client, { moved: [["1-projects/shared", "2-areas/shared"]], visibilityOf });
    assert.deepEqual(store.reads, []);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), []);
    assert.deepEqual(pathsIn(d1, "notes_private_fts"), ["2-areas/shared/plan.md"]);
    assert.equal(d1.rows("SELECT visibility FROM notes")[0].visibility, "private");
  }),
);

test(
  "a moved folder's notes change tier with no reads, however many there are",
  withD1(async (d1, client) => {
    const seeded = {};
    for (let n = 0; n < 3; n += 1) seeded[`1-projects/team/n${n}.md`] = `# N${n}\n\nquokka\n`;
    await seedRows(client, seeded);
    const store = noteStore({});
    const result = await followChange(store, client, {
      moved: [["1-projects/team", "2-areas/team"]],
      visibilityOf,
      noteCap: 1,
    });
    assert.equal(result.projected, 0);
    assert.equal(result.deferred, 0);
    assert.deepEqual(store.reads, []);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), []);
    assert.deepEqual(pathsIn(d1, "notes_private_fts"), ["2-areas/team/n0.md", "2-areas/team/n1.md", "2-areas/team/n2.md"]);
    assert.deepEqual(d1.rows("SELECT DISTINCT visibility FROM notes").map((row) => row.visibility), ["private"]);
    assert.equal(d1.rows("SELECT title FROM notes_private_fts WHERE path = ?", ["2-areas/team/n1.md"])[0].title, "N1");
  }),
);

test(
  "a note moved to another folder under the same name is renamed in place, with no read",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/a/plan.md": "# Plan\n\nquokka\n",
      "1-projects/b/plan.md": "# Stale\n\nwombat\n",
    });
    const store = noteStore({});
    const result = await followChange(store, client, {
      moved: [["1-projects/a/plan.md", "1-projects/b/plan.md"]],
      visibilityOf,
    });
    assert.deepEqual(store.reads, []);
    assert.equal(result.renamed, 1);
    assert.equal(result.projected, 0);
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/b/plan.md"]);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), ["1-projects/b/plan.md"]);
    assert.deepEqual(d1.rows("SELECT body FROM notes_team_fts").map((row) => row.body.includes("quokka")), [true]);
    // The version is kept, so the sweep still checks the renamed row.
    assert.equal(d1.rows("SELECT version FROM notes")[0].version, "old-1-projects/a/plan.md");
  }),
);

test(
  "a note moved somewhere narrower under the same name leaves the wider tier, with no read",
  withD1(async (d1, client) => {
    await seedRows(client, { "1-projects/plan.md": "# Plan\n\nquokka\n" });
    const store = noteStore({});
    await followChange(store, client, { moved: [["1-projects/plan.md", "2-areas/plan.md"]], visibilityOf });
    assert.deepEqual(store.reads, []);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), []);
    assert.deepEqual(pathsIn(d1, "notes_private_fts"), ["2-areas/plan.md"]);
    assert.equal(d1.rows("SELECT visibility FROM notes")[0].visibility, "private");
  }),
);

test(
  "a same-name move the projection does not hold yet, and a renamed note, are read and projected",
  withD1(async (d1, client) => {
    await seedRows(client, { "1-projects/old.md": "# Old\n\nquokka\n" });
    const store = noteStore({
      "1-projects/b/new.md": "# New\n\nquokka\n",
      "1-projects/b/fresh.md": "# Fresh\n\nquokka\n",
    });
    const result = await followChange(store, client, {
      moved: [
        ["1-projects/old.md", "1-projects/b/new.md"],
        ["1-projects/a/fresh.md", "1-projects/b/fresh.md"],
      ],
      visibilityOf,
    });
    assert.deepEqual([...store.reads].sort(), ["1-projects/b/fresh.md", "1-projects/b/new.md"]);
    assert.equal(result.projected, 2);
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/b/fresh.md", "1-projects/b/new.md"]);
  }),
);

test(
  "a gone note or folder loses its rows; plumbing and folders are never projected",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/keep.md": "# Keep\n\nquokka\n",
      "1-projects/gone.md": "# Gone\n\nquokka\n",
      "1-projects/trash/a.md": "# A\n\nquokka\n",
    });
    const store = noteStore({ ".context/x.md": "secret", "1-projects/folder": "x" });
    await followChange(store, client, {
      gone: ["1-projects/gone.md", "1-projects/trash"],
      written: [".context/x.md", "1-projects/folder"],
      visibilityOf,
    });
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/keep.md"]);
    assert.deepEqual(store.reads, []);
  }),
);

test(
  "a note or folder moved somewhere the projection does not hold, like the trash, still leaves",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/keep.md": "# Keep\n\nquokka\n",
      "1-projects/binned.md": "# Binned\n\nquokka\n",
      "1-projects/old/a.md": "# A\n\nquokka\n",
    });
    const store = noteStore({ "1-projects/back.md": "# Back\n\nquokka\n" });
    await followChange(store, client, {
      moved: [
        ["1-projects/binned.md", ".context/trash/binned.md"],
        ["1-projects/old", ".context/trash/old"],
        [".context/trash/back.md", "1-projects/back.md"],
      ],
      visibilityOf,
    });
    assert.deepEqual(pathsIn(d1, "notes"), ["1-projects/back.md", "1-projects/keep.md"]);
    assert.deepEqual(store.reads, ["1-projects/back.md"]);
  }),
);

test("which changes are followed, and which their writer already projected", () => {
  assert.equal(searchChangeOf("update_note", ["a.md"], {}).follow, null);
  assert.equal(searchChangeOf("create_note", ["a.md"], {}).follow, null);
  assert.deepEqual(searchChangeOf("save_context", ["a.md"], {}).follow, { written: ["a.md"] });
  assert.deepEqual(searchChangeOf("inbox_capture", ["0-inbox/m.md"], {}).follow, { written: ["0-inbox/m.md"] });
  assert.deepEqual(searchChangeOf("move_note", ["a.md", "b.md"], {}).follow, { moved: [["a.md", "b.md"]] });
  assert.deepEqual(searchChangeOf("move_notes", ["a.md", "b.md", "c.md", "d.md"], {}).follow, {
    moved: [["a.md", "b.md"], ["c.md", "d.md"]],
    written: [],
  });
  // A partial bulk move: one applied pair, then a copy whose source stayed.
  assert.deepEqual(searchChangeOf("move_notes", ["a.md", "b.md", "d.md"], { partial: true, moved: 1 }).follow, {
    moved: [["a.md", "b.md"]],
    written: ["d.md"],
  });
  assert.deepEqual(searchChangeOf("move_folder", ["x", "y"], { count: 3 }).follow, { moved: [["x", "y"]] });
  // Still only logical: the bucket holds the old layout until it materializes.
  assert.equal(searchChangeOf("move_folder", ["x", "y"], { status: "logical_active" }), null);
  assert.equal(searchChangeOf("move_folder", ["x", "y"], { count: 3, queued: true }), null);
  // An access change moves the tier and reads nothing (2026-10-29: it was
  // `null`, and a note opened to the team never reached a team search).
  assert.deepEqual(searchChangeOf("set_visibility", ["a.md"], {}), { notes: [], follow: { retiered: ["a.md"] } });
  assert.deepEqual(searchChangeOf("set_folder_visibility", ["2-areas"], {}).follow, { retiered: ["2-areas"] });
});

/*
  Found 2026-10-29 in a CASA setup: a fresh note opened to the team was read
  by a team-tier connection and its exact title searched nothing. The rows
  sat in the private table, and the sweep re-projects only a version it does
  not hold, which an access change never touches.
*/
test(
  "a note opened to the team moves to the team tier with no read, and a team search finds it",
  withD1(async (d1, client) => {
    await seedRows(client, { "2-areas/zap synthetic note.md": "# zap synthetic note\n\nquokka\n" });
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), []);
    const store = noteStore({});
    const opened = (path) => (path === "2-areas/zap synthetic note.md" ? "team" : visibilityOf(path));
    await followChange(store, client, { retiered: ["2-areas/zap synthetic note.md"], visibilityOf: opened });
    assert.deepEqual(store.reads, []);
    assert.deepEqual(pathsIn(d1, "notes_private_fts"), []);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), ["2-areas/zap synthetic note.md"]);
    assert.equal(d1.rows("SELECT visibility FROM notes")[0].visibility, "team");
    const found = d1.rows("SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?", ['"zap" "synthetic" "note"']);
    assert.deepEqual(found.map((row) => row.path), ["2-areas/zap synthetic note.md"]);
    // The version is kept: nothing was read, so nothing newer is known.
    assert.equal(d1.rows("SELECT version FROM notes")[0].version, "old-2-areas/zap synthetic note.md");
  }),
);

test(
  "a folder narrowed takes its notes out of the team tier, each once, even when a note is named too",
  withD1(async (d1, client) => {
    await seedRows(client, {
      "1-projects/a.md": "# A\n\nquokka\n",
      "1-projects/b.md": "# B\n\nquokka\n",
      "1-projects-notes.md": "# Sibling\n\nquokka\n",
    });
    const store = noteStore({});
    const narrowed = (path) => (path.startsWith("1-projects/") ? "private" : visibilityOf(path));
    await followChange(store, client, { retiered: ["1-projects", "1-projects/a.md", "1-projects/a.md"], visibilityOf: narrowed });
    assert.deepEqual(store.reads, []);
    assert.deepEqual(pathsIn(d1, "notes_private_fts"), ["1-projects-notes.md", "1-projects/a.md", "1-projects/b.md"]);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), []);
    // Each note's chunks moved once: none lost to a second move, none doubled.
    assert.equal(d1.rows("SELECT COUNT(*) AS n FROM notes_private_fts WHERE path = ?", ["1-projects/a.md"])[0].n, 1);
  }),
);

test(
  "an access change for a note the projection does not hold, or a tier it already has, writes nothing",
  withD1(async (d1, client) => {
    await seedRows(client, { "1-projects/a.md": "# A\n\nquokka\n" });
    const before = d1.rows("SELECT path, visibility, version FROM notes");
    const store = noteStore({});
    await followChange(store, client, { retiered: ["1-projects/a.md", "2-areas/absent.md", "../x.md", ".context/y.md"], visibilityOf });
    assert.deepEqual(store.reads, []);
    assert.deepEqual(d1.rows("SELECT path, visibility, version FROM notes"), before);
    assert.deepEqual(pathsIn(d1, "notes_team_fts"), ["1-projects/a.md"]);
  }),
);

/* ---------------------------------------------------------------------- */
/*                  end to end, through the worker                         */
/* ---------------------------------------------------------------------- */

const TOKEN = `cat_follow_owner_${"0".repeat(17)}`;
const WS = "ws_follow";

test("through the worker: a moved note and a moved folder are searchable at their new paths at once", async () => {
  assert.ok(DatabaseSync, "node:sqlite is available");
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restoreS3 = s3.install();
  const restoreD1 = d1.install();
  const restoreControlPlane = controlPlane.install();
  try {
    controlPlane.addWorkspace(WS, "follow", s3Binding("follow-bucket", DESCRIPTOR));
    // Writes ask the Convex tree whether a name is taken (`src/tree/names.js`).
    controlPlane.serveTreesFrom(null, { s3 });
    await controlPlane.addGrant({
      accessToken: TOKEN,
      workspaceId: WS,
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_follow_owner",
      userId: "user_follow_owner",
    });
    const bucket = s3.bucketFor("follow-bucket");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "fp0" });
    bucket.set("1-projects/older.md", { body: "# Older\n\nA bilby was seen once.\n", etag: "f1" });
    bucket.set("1-projects/trip/day-one.md", { body: "# Day one\n\nThe dunnart camp.\n", etag: "f2" });
    bucket.set("1-projects/trip/day-two.md", { body: "# Day two\n\nMore dunnart tracks.\n", etag: "f3" });

    async function call(name, args) {
      const harness = createWorkerCtx();
      const response = await worker.fetch(
        new Request("https://gateway.test/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, SEARCH_SUBREQUEST_BUDGET: "600" },
        harness.ctx,
      );
      const body = await response.json();
      await harness.settle();
      return JSON.stringify(body);
    }

    // Filled the way the control plane fills it, then served from it.
    fillSearchDatabase(d1.dbFor(DESCRIPTOR.databaseId), [
      { path: "1-projects/older.md", content: "# Older\n\nA bilby was seen once.\n", visibility: "team" },
      { path: "1-projects/trip/day-one.md", content: "# Day one\n\nThe dunnart camp.\n", visibility: "team" },
      { path: "1-projects/trip/day-two.md", content: "# Day two\n\nMore dunnart tracks.\n", visibility: "team" },
    ]);
    controlPlane.bindings.set(WS, s3Binding("follow-bucket", READY));

    await call("write_note", { path: "1-projects/fresh.md", content: "# Fresh\n\nA second bilby, just now.\n" });
    const afterWrite = await call("search_notes", { query: "bilby" });
    assert.ok(afterWrite.includes("1-projects/fresh.md"), "the written note is found");

    await call("move_note", { source: "1-projects/fresh.md", destination: "1-projects/renamed.md" });
    const afterMove = await call("search_notes", { query: "bilby" });
    assert.ok(afterMove.includes("1-projects/renamed.md"), `a moved note is found at its new path: ${afterMove}`);
    assert.ok(!afterMove.includes("1-projects/fresh.md"), `and not at its old one: ${afterMove}`);

    await call("move_folder", { source: "1-projects/trip", destination: "1-projects/journey" });
    const afterFolder = await call("search_notes", { query: "dunnart" });
    assert.ok(afterFolder.includes("1-projects/journey/day-one.md"), `a moved folder's notes are found under it: ${afterFolder}`);
    assert.ok(!afterFolder.includes("1-projects/trip/"), `and not under the old folder: ${afterFolder}`);
  } finally {
    restoreControlPlane();
    restoreD1();
    restoreS3();
    d1.close();
  }
});
