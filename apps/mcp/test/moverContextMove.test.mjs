/**
 * The mover's batches between two workspaces (`src/moves/contextMovePage.js`
 * behind `src/moves/mover.js`): each file read from one bucket, landed in the
 * other only if nothing is there, and retired from the first only if it is
 * still what was read.
 *
 * Sabotage, each confirmed to fail a case here: retire the source without its
 * etag (the edit-during-move case), land over something already there (the
 * destination-exists case), carry a note encrypted to its own workspace (the
 * encrypted case), or accept a page whose two sides are one workspace (the
 * one-workspace case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleMoverPage, MOVER_PAGE_PATH } from "../src/moves/mover.js";
import { runContextMovePage } from "../src/moves/contextMovePage.js";

const SECRET = "gateway-secret-for-tests";
const env = { GATEWAY_SECRET: SECRET };

class MemoryStore {
  constructor(seed = {}, capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false }) {
    this.objects = new Map();
    this.n = 0;
    this.capabilities = capabilities;
    this.afterGet = null;
    for (const [key, text] of Object.entries(seed)) this.set(key, text);
  }
  set(key, text) {
    this.objects.set(key, { bytes: new TextEncoder().encode(text), etag: `s${++this.n}` });
  }
  text(key) {
    const hit = this.objects.get(key);
    return hit ? new TextDecoder().decode(hit.bytes) : null;
  }
  async get(key) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const read = { etag: hit.etag, size: hit.bytes.byteLength, arrayBuffer: async () => hit.bytes.slice().buffer };
    await this.afterGet?.(key);
    return read;
  }
  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.absent && existing) return null;
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `e${++this.n}`;
    this.objects.set(key, { bytes: new Uint8Array(value), etag });
    return { etag };
  }
  async delete(key) {
    this.objects.delete(key);
  }
}

const object = (name, size = 10) => ({ source: `1-projects/acme/${name}`, destination: `work/acme/${name}`, size });

function page(objects, overrides = {}) {
  return {
    kind: "contextMove",
    source: { workspaceId: "ws-source", provider: "r2", bucket: "source" },
    destination: { workspaceId: "ws-destination", provider: "r2", bucket: "destination" },
    noteCap: null,
    objects,
    limits: { lanes: 6, byteBudget: 16 * 1024 * 1024, maxObjectBytes: 20 * 1024 * 1024 },
    ...overrides,
  };
}

function stores(seed = {}, destinationSeed = {}) {
  // A source with no collaboration history to keep (it cannot create only if
  // absent), so its notes retire by the conditional-write marker R2 uses.
  const source = new MemoryStore(seed, { conditionalWrite: true, conditionalCreate: false, conditionalDelete: false });
  const destination = new MemoryStore(destinationSeed);
  const built = [];
  const buildStore = (binding, _env, options) => {
    built.push({ bucket: binding.bucket, options });
    return binding.bucket === "source" ? source : destination;
  };
  return { source, destination, built, buildStore };
}

function request() {
  return new Request(`https://gateway.example${MOVER_PAGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ ticket: "t1" }),
  });
}

test("files land in the other bucket and leave the first, through the mover's door", async () => {
  const s = stores({ "1-projects/acme/a.md": "# A\n", "1-projects/acme/b.png": "PNG" });
  const response = await handleMoverPage(request(), env, {
    controlPlane: { openMoverPage: async () => page([object("a.md"), object("b.png")]) },
    buildStore: s.buildStore,
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.landed.map((entry) => entry.destination).sort(), ["work/acme/a.md", "work/acme/b.png"]);
  assert.deepEqual(body.conflicts, []);
  assert.equal(body.failure, null);
  assert.equal(s.destination.text("work/acme/a.md"), "# A\n");
  assert.equal(s.destination.text("work/acme/b.png"), "PNG");
  assert.equal(s.source.objects.has("1-projects/acme/a.md"), false);
  assert.equal(s.source.objects.has("1-projects/acme/b.png"), false);
  // The destination's cap goes to the destination's store, and only there.
  assert.deepEqual(s.built.map((entry) => [entry.bucket, "noteCap" in entry.options]), [["source", false], ["destination", true]]);
});

test("a note edited while it moved keeps the edit, and the copy is taken back", async () => {
  const s = stores({ "1-projects/acme/a.md": "# A\n" });
  s.source.afterGet = async (key) => {
    s.source.afterGet = null;
    s.source.set(key, "# A, edited\n");
  };
  const result = await runContextMovePage(page([object("a.md")]), { buildStore: s.buildStore });
  assert.deepEqual(result.conflicts, ["1-projects/acme/a.md"]);
  assert.deepEqual(result.landed, []);
  assert.equal(s.source.text("1-projects/acme/a.md"), "# A, edited\n");
  assert.equal(s.destination.objects.has("work/acme/a.md"), false);
});

test("something already at the destination stops the batch and is never overwritten", async () => {
  const s = stores({ "1-projects/acme/a.md": "# A\n" }, { "work/acme/a.md": "# theirs\n" });
  const result = await runContextMovePage(page([object("a.md")]), { buildStore: s.buildStore });
  assert.deepEqual(result.failure, { destination: "work/acme/a.md", code: "DESTINATION_EXISTS" });
  assert.equal(s.destination.text("work/acme/a.md"), "# theirs\n");
  assert.equal(s.source.text("1-projects/acme/a.md"), "# A\n");
});

test("a note encrypted to its own workspace, or a file over the limit, stays and is named", async () => {
  const s = stores({
    "1-projects/acme/secret.md": "---\ncontext_encryption: v1\n---\n\nAAAAAAAAAAAAAAAA\n",
    "1-projects/acme/big.mov": "x".repeat(200),
  });
  const result = await runContextMovePage(
    page([object("secret.md"), object("big.mov", 200)], { limits: { lanes: 6, byteBudget: 1024, maxObjectBytes: 100 } }),
    { buildStore: s.buildStore },
  );
  assert.deepEqual(
    result.skipped.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "1-projects/acme/big.mov", reason: "too_large" },
      { path: "1-projects/acme/secret.md", reason: "encrypted" },
    ],
  );
  assert.equal(s.destination.objects.size, 0);
  assert.equal(s.source.objects.size, 2);
});

test("a page whose two sides are one workspace, or that names too many files, opens nothing", async () => {
  for (const bad of [
    page([object("a.md")], { destination: { workspaceId: "ws-source", provider: "r2", bucket: "destination" } }),
    page(Array.from({ length: 41 }, (_, index) => object(`n${index}.md`))),
    page([]),
    page([{ source: "1-projects/acme/a.md", destination: "work/acme/a.md" }]),
  ]) {
    const s = stores({ "1-projects/acme/a.md": "# A\n" });
    const response = await handleMoverPage(request(), env, {
      controlPlane: { openMoverPage: async () => bad },
      buildStore: s.buildStore,
    });
    assert.deepEqual(await response.json(), { ok: false, error: "STORAGE_UNSAFE" });
    assert.equal(s.built.length, 0);
    assert.equal(s.source.text("1-projects/acme/a.md"), "# A\n");
  }
});
