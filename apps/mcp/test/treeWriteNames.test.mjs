/**
 * A gateway write asks the Convex tree whether a name is taken, never the
 * bucket (step 3 of the convex-only plan, `src/tree/names.js`), and the write
 * itself is the truth for a name the tree has not heard of yet.
 *
 * The control plane's tree is a stub here (`controlPlaneStub/tree.mjs`) whose
 * source a test steers apart from the bucket: a name only the tree holds
 * proves the tree was asked; a name only the bucket holds proves the
 * conditional write still refuses it.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - `move_note`, `archive_note` or `move_folder` GETting the destination
 *    from the bucket again: the "only the tree holds" cases move onto it;
 *  - `move_note`'s put without `onlyIf: { absent: true }`: the "only the
 *    bucket holds" case overwrites the stranger's drawing;
 *  - the collaborative move's `DESTINATION_EXISTS` read as "source changed":
 *    the same case is told the wrong thing;
 *  - `set_folder_visibility` listing the bucket: it counts one note, not three;
 *  - `destinationRefusal` treating a tree that cannot answer as "free": the
 *    loading case moves the note.
 */

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

const OWNER = "cat_test_treenames_owner_000000000000";
const WS = "ws_treenames";
const PRIVACY =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n" +
  "```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  1-projects: team\n  2-areas: private\n  4-archive: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function memoryBucket() {
  const objects = new Map();
  let etags = 0;
  const encoder = new TextEncoder();
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return { etag, size: bytes.length, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    async head(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return { etag, size: bytes.length };
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      // R2's own "only if absent" (`R2Store` translates `{ absent: true }` to it).
      if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
      const etag = `e${++etags}`;
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix } = {}) {
      const listed = [...objects.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: objects.get(key).bytes.length, uploaded: new Date(), etag: objects.get(key).etag }));
      return { objects: listed, truncated: false };
    },
  };
}

/** The tree: the bucket, with names it has heard of that the bucket lacks (`extra`) and names it has not heard of yet (`unheard`). */
function treeOf(bucket) {
  const extra = new Map();
  const unheard = new Set();
  const keys = () => [...new Set([...bucket.objects.keys(), ...extra.keys()])].filter((key) => !unheard.has(key)).sort();
  return {
    extra,
    unheard,
    async list({ prefix = "" } = {}) {
      return { objects: keys().filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: "t" })), truncated: false };
    },
    async get(key) {
      if (unheard.has(key)) return null;
      if (extra.has(key)) return { etag: "t", text: async () => extra.get(key) };
      return await bucket.get(key);
    },
  };
}

async function scenario() {
  const bucket = memoryBucket();
  const store = new R2Store(bucket);
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace(WS, "treenames", {
    provider: "r2-binding",
    bindingName: "CONTEXT_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  await controlPlane.addGrant({
    accessToken: OWNER,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_treenames",
    clientName: "Claude Code",
    userId: "user_treenames_owner",
  });
  const tree = treeOf(bucket);
  controlPlane.serveTree(WS, tree);
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, NATIVE_BINDINGS: "CONTEXT_BUCKET", CONTEXT_BUCKET: bucket };
  await store.put("privacy.md", PRIVACY);
  await store.put("1-projects/plan.md", "# Plan\n");
  let id = 0;
  async function call(name, args) {
    const deferred = [];
    const response = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }),
      env,
      { waitUntil: (work) => deferred.push(work) },
    );
    const result = (await response.json()).result;
    await Promise.allSettled(deferred);
    return { error: result?.isError === true, text: result?.content?.[0]?.text ?? "" };
  }
  return { bucket, tree, controlPlane, call, restore };
}

test("move_note refuses a destination only the tree holds: the tree was asked, not the bucket", async () => {
  const s = await scenario();
  try {
    s.tree.extra.set("1-projects/taken.md", "# Taken\n");
    const moved = await s.call("move_note", { source: "1-projects/plan.md", destination: "1-projects/taken.md" });
    assert.equal(moved.error, true);
    assert.match(moved.text, /destination already exists/);
    assert.ok(s.bucket.objects.has("1-projects/plan.md"), "nothing moved");
    assert.ok(!s.bucket.objects.has("1-projects/taken.md"));
  } finally {
    s.restore();
  }
});

test("move_note onto a note the tree has not heard of yet is refused by the write, never an overwrite", async () => {
  const s = await scenario();
  try {
    await new R2Store(s.bucket).put("1-projects/just-written.md", "# Written a second ago\n");
    s.tree.unheard.add("1-projects/just-written.md");
    const moved = await s.call("move_note", { source: "1-projects/plan.md", destination: "1-projects/just-written.md" });
    assert.equal(moved.error, true);
    assert.match(moved.text, /destination already exists/);
    assert.match(new TextDecoder().decode(s.bucket.objects.get("1-projects/just-written.md").bytes), /a second ago/);
    assert.ok(s.bucket.objects.has("1-projects/plan.md"));

    // A drawing is not collaboratively edited, so it takes the plain put.
    await new R2Store(s.bucket).put("1-projects/sketch.excalidraw.md", "# Sketch\n");
    await new R2Store(s.bucket).put("1-projects/fresh.excalidraw.md", "# Drawn a second ago\n");
    s.tree.unheard.add("1-projects/fresh.excalidraw.md");
    const drawing = await s.call("move_note", { source: "1-projects/sketch.excalidraw.md", destination: "1-projects/fresh.excalidraw.md" });
    assert.equal(drawing.error, true, drawing.text);
    assert.match(drawing.text, /destination already exists/);
    assert.match(new TextDecoder().decode(s.bucket.objects.get("1-projects/fresh.excalidraw.md").bytes), /a second ago/);
  } finally {
    s.restore();
  }
});

test("archive_note and move_folder ask the tree too", async () => {
  const s = await scenario();
  try {
    await new R2Store(s.bucket).put("1-projects/launch/brief.md", "# Brief\n");
    s.tree.extra.set("1-projects/next/brief.md", "# Someone else's\n");
    const folder = await s.call("move_folder", { source: "1-projects/launch", destination: "1-projects/next" });
    assert.equal(folder.error, true);
    assert.match(folder.text, /destination already exists: 1-projects\/next\/brief\.md/);
    assert.ok(s.bucket.objects.has("1-projects/launch/brief.md"));

    // An archive destination is stamped to the millisecond, so the tree is
    // made to hold every name under the archive the note could land at.
    const realList = s.tree.list;
    const realGet = s.tree.get;
    s.tree.get = async (key) => (key.startsWith("4-archive/") ? { etag: "t", text: async () => "x" } : await realGet(key));
    const archived = await s.call("archive_note", { path: "1-projects/plan.md" });
    s.tree.get = realGet;
    s.tree.list = realList;
    assert.equal(archived.error, true);
    assert.match(archived.text, /archive destination already exists/);
    assert.ok(s.bucket.objects.has("1-projects/plan.md"));
  } finally {
    s.restore();
  }
});

test("a workspace still loading is told so, and nothing is moved on a guess", async () => {
  const s = await scenario();
  try {
    s.controlPlane.stopServing(WS);
    const moved = await s.call("move_note", { source: "1-projects/plan.md", destination: "1-projects/renamed.md" });
    assert.equal(moved.error, true);
    assert.match(moved.text, /still loading/);
    assert.ok(s.bucket.objects.has("1-projects/plan.md"));
    assert.ok(!s.bucket.objects.has("1-projects/renamed.md"));
  } finally {
    s.restore();
  }
});

test("set_folder_visibility counts the notes it reaches from the tree", async () => {
  const s = await scenario();
  try {
    s.tree.extra.set("2-areas/a.md", "# A\n");
    s.tree.extra.set("2-areas/b.md", "# B\n");
    await new R2Store(s.bucket).put("2-areas/c.md", "# C\n");
    const dry = await s.call("set_folder_visibility", { path: "2-areas", visibility: "team", dry_run: true });
    assert.equal(dry.error, false, dry.text);
    assert.match(dry.text, /notes_scanned: 3/);
  } finally {
    s.restore();
  }
});
