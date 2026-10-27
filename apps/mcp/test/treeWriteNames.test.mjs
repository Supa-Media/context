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
 *    not-served case moves the note;
 *  - `write_note` opening the note to learn whether it exists: the "new name"
 *    case reads the bucket at that name;
 *  - `write_note`'s create without `onlyIf: { absent: true }`: the "written a
 *    moment ago" case overwrites the note;
 *  - the status list opening front notes instead of asking the tree: the
 *    "only the tree holds" front note is never found.
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

test("a workspace the tree does not serve is told so, and nothing is moved on a guess", async () => {
  const s = await scenario();
  try {
    s.controlPlane.stopServing(WS);
    const moved = await s.call("move_note", { source: "1-projects/plan.md", destination: "1-projects/renamed.md" });
    assert.equal(moved.error, true);
    assert.match(moved.text, /could not be read just now/);
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

test("write_note asks the tree whether the note exists, and never opens a name the tree calls free", async () => {
  const s = await scenario();
  try {
    const events = [];
    const get = s.bucket.get.bind(s.bucket);
    const put = s.bucket.put.bind(s.bucket);
    const treeGet = s.tree.get;
    // The stub tree is copied from this same bucket: its reads are the tree's, not the gateway's.
    s.tree.get = async (key) => (s.tree.unheard.has(key) || s.tree.extra.has(key) ? await treeGet(key) : await get(key));
    s.bucket.get = async (key) => {
      events.push(`get ${key}`);
      return await get(key);
    };
    s.bucket.put = async (key, value, options) => {
      events.push(`put ${key}`);
      return await put(key, value, options);
    };
    const created = await s.call("write_note", { path: "1-projects/new.md", content: "# New\n" });
    assert.equal(created.error, false, created.text);
    // Before the note lands, one read: the store's own put, which looks for a
    // deleted-note marker at the name (`store/logicalDelete.js`). Nothing
    // opens the note to ask whether it exists; the tree said.
    const touching = events.filter((event) => event.endsWith(" 1-projects/new.md"));
    assert.deepEqual(touching.slice(0, touching.indexOf("put 1-projects/new.md") + 1), ["get 1-projects/new.md", "put 1-projects/new.md"]);

    // A name the tree draws is opened, and is the edit it is.
    const edited = await s.call("write_note", { path: "1-projects/plan.md", content: "# Plan, edited\n" });
    assert.match(edited.text, /collaboratively edited note already exists/);
  } finally {
    s.restore();
  }
});

test("write_note over a note written a moment ago, before the tree heard of it, never overwrites it as new", async () => {
  const s = await scenario();
  try {
    await new R2Store(s.bucket).put("1-projects/twice.md", "# Written a moment ago\n");
    s.tree.unheard.add("1-projects/twice.md");
    const again = await s.call("write_note", { path: "1-projects/twice.md", content: "# Written again\n" });
    assert.equal(again.error, true);
    assert.match(again.text, /created while this write was in progress; re-read/);
    assert.match(new TextDecoder().decode(s.bucket.objects.get("1-projects/twice.md").bytes), /a moment ago/);
    // Re-read and written with the etag it read: an edit opens the note without asking the tree.
    const etag = s.bucket.objects.get("1-projects/twice.md").etag;
    const edited = await s.call("write_note", { path: "1-projects/twice.md", content: "# Written again\n", expected_etag: etag });
    assert.equal(edited.error, false, edited.text);
    assert.match(new TextDecoder().decode(s.bucket.objects.get("1-projects/twice.md").bytes), /again/);
  } finally {
    s.restore();
  }
});

test("write_note refuses while the tree cannot say whether the note exists", async () => {
  const s = await scenario();
  try {
    s.controlPlane.stopServing(WS);
    const refused = await s.call("write_note", { path: "1-projects/new.md", content: "# New\n" });
    assert.equal(refused.error, true);
    assert.ok(!s.bucket.objects.has("1-projects/new.md"));
  } finally {
    s.restore();
  }
});

test("a folder's statuses come from its front note's front matter in the tree, never from opening the note", async () => {
  const s = await scenario();
  try {
    s.tree.extra.set("1-projects/about.md", "---\nstatuses-in-progress: [drafting]\n---\n# Projects\n");
    const written = await s.call("write_note", { path: "1-projects/idea.md", content: "---\nstatus: brewing\n---\n# Idea\n" });
    assert.equal(written.error, false, written.text);
    assert.match(written.text, /not one of the statuses for 1-projects\//);
    assert.match(written.text, /drafting/);
  } finally {
    s.restore();
  }
});
