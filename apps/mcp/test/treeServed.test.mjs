/**
 * The agent tools that list read the Convex tree, and only the Convex tree
 * (`src/tree/served.js`, phase 5 of
 * `docs/decisions/app-and-console/convex-tree.md`; owner, 2026-10-13: "I
 * don't want to see even fallbacks").
 *
 * The bucket below counts every listing it answers, so "the tool never walks
 * the bucket" is a number, not a reading of the code. Every tool's answer is
 * compared with the answer a tree that holds every key the bucket does gives
 * (no narrowing, so the tools' own rules are the only filter), at owner and
 * team clearance, so serving from the tree changes where the keys and front
 * matter come from and nothing a person sees. A store with no control plane
 * has no tree and lists nothing (`TreeUnavailable`); it never walks the bucket.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `canSee` dropped from `listVisibleNoteKeys` while the tree sends a
 *    private key at team clearance: "a key the tree wrongly sends is still
 *    held back by the gateway's own rules" fails. The gateway's filter is the
 *    second gate, not a formality.
 * 2. `servedListingStore` applied to every tool, writes included: "a tool
 *    outside the six, writes included, never asks the tree" fails.
 * 3. An unserved answer read as an empty tree (`return []` in place of the
 *    `TreeUnavailable` throw): "a workspace the tree does not serve is told
 *    it is still loading" fails.
 * 4. A failed request falling back to `store.list`: "a failed request says
 *    so, and lists nothing" fails on the bucket's listing count.
 * 5. Plumbing prefixes sent to the tree: "plumbing is listed from the bucket"
 *    and "one call reads the tree once" fail.
 *
 * Sabotage 1 also fails the team-clearance comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callTool, TREE_LISTING_TOOLS } from "../src/tools/dispatch.js";
import { compareKeys, servedListingStore, TREE_LOADING, TREE_UNREACHABLE, TreeUnavailable } from "../src/tree/served.js";
import { propsOf } from "../src/tree/props.js";

const PRIVACY =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  0-inbox: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const NOTES = {
  "index.md": "# Home\n",
  "privacy.md": PRIVACY,
  "1-projects/about.md": "# Projects\n\n```list\nfrom: 1-projects/alpha\nshow: status\n```\n",
  "1-projects/alpha/overview.md": "---\nstatus: in progress\n---\n# Alpha\n",
  "1-projects/alpha/notes.md": "# Alpha notes\n",
  "1-projects/beta.md": "# Beta\n",
  "2-areas/health.md": "# Private health\n",
  "0-inbox/meetings/2026-10-01-standup.md": "---\ntitle: Standup\nstarted: 2026-10-01T09:00:00Z\n---\n# Standup\n",
  "0-inbox/contacts/ana.md": "---\nname: Ana\n---\n# Ana\n",
  ".context/moves/state.json": "{}",
};

/** A bucket in memory that lists the way the S3 adapter does, and counts its listings. */
function bucketOf(notes) {
  const objects = new Map(Object.entries(notes).map(([key, text], index) => [key, { text, etag: `e${index}`, uploaded: Date.UTC(2026, 9, 1 + index) }]));
  const listings = [];
  const gets = [];
  return {
    listings,
    gets,
    objects,
    async list({ prefix = "", delimiter, cursor, startAfter, limit = 1000 } = {}) {
      listings.push(prefix);
      const after = cursor ?? startAfter;
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || compareKeys(key, after) > 0))
        .sort(compareKeys);
      const out = [];
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const slash = delimiter ? rest.indexOf("/") : -1;
        if (slash >= 0) prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
        else out.push(key);
      }
      const page = out.slice(0, limit);
      return {
        objects: page.map((key) => ({ key, etag: objects.get(key).etag, size: objects.get(key).text.length, uploaded: new Date(objects.get(key).uploaded) })),
        delimitedPrefixes: [...prefixes],
        truncated: out.length > page.length,
        ...(out.length > page.length ? { cursor: page[page.length - 1] } : {}),
      };
    },
    async get(key) {
      gets.push(key);
      const object = objects.get(key);
      if (!object) return null;
      return { key, etag: object.etag, size: object.text.length, uploaded: new Date(object.uploaded), text: async () => object.text };
    },
    async head(key) {
      return (await this.get(key)) ?? null;
    },
  };
}

/**
 * What the control plane would send: every non-plumbing key the clearance
 * sees, from the tree. `see` is that clearance's filter, so a test can make
 * the tree send something it should not.
 */
function treeOf(bucket, { see = () => true, pageSize = 3, served = true } = {}) {
  const requests = [];
  const manifest = async ({ folder, cursor } = {}) => {
    requests.push({ folder, cursor });
    if (served instanceof Error) throw served;
    if (!served) return { served: false };
    const prefix = folder ? `${folder}/` : "";
    const keys = [...bucket.objects.keys()]
      .filter((key) => !key.startsWith(".") && key.startsWith(prefix) && see(key))
      .sort(compareKeys)
      .filter((key) => cursor === undefined || compareKeys(key, cursor) > 0);
    const page = keys.slice(0, pageSize);
    const more = keys.length > page.length;
    return {
      served: true,
      entries: page.map((path) => ({
        path,
        etag: bucket.objects.get(path).etag,
        size: bucket.objects.get(path).text.length,
        updatedAt: bucket.objects.get(path).uploaded,
      })),
      cursor: more ? page[page.length - 1] : null,
    };
  };
  /** Each note's props as the tree's fill parses them; only for keys the clearance sees. */
  const facts = async ({ ask, paths } = {}) => {
    requests.push({ ask, paths });
    if (ask !== "props" || !Array.isArray(paths)) return { served: false };
    return {
      served: true,
      props: paths
        .filter((path) => bucket.objects.has(path) && see(path))
        .map((path) => {
          const parsed = propsOf(bucket.objects.get(path).text);
          return { path, version: bucket.objects.get(path).etag, sealed: parsed === null, props: parsed && JSON.stringify(parsed) };
        }),
    };
  };
  return { requests, manifest, facts };
}

function served(bucket, tree) {
  const store = Object.create(bucket);
  Object.defineProperty(store, "treeManifest", { value: tree.manifest, enumerable: false });
  if (tree.facts) Object.defineProperty(store, "treeFacts", { value: tree.facts, enumerable: false });
  return store;
}

const teamSees = (key) => key.startsWith("1-projects/") || key.startsWith("0-inbox/");

const CALLS = [
  ["orient", {}],
  ["list_notes", {}],
  ["list_notes", { prefix: "1-projects" }],
  ["list_meetings", {}],
  ["list_contacts", {}],
  ["list_channel_days", {}],
  ["evaluate_lists", { path: "1-projects/about.md" }],
];

for (const scope of ["private", "team"]) {
  test(`at ${scope} clearance, every listing tool answers as the bucket does, without listing a note folder`, async () => {
    for (const [name, args] of CALLS) {
      const plainBucket = bucketOf(NOTES);
      const plain = served(plainBucket, treeOf(plainBucket, { see: () => true, pageSize: 1000 }));
      const expected = await callTool(name, args, plain, scope);
      const bucket = bucketOf(NOTES);
      const tree = treeOf(bucket, { see: scope === "private" ? () => true : teamSees });
      const actual = await callTool(name, args, served(bucket, tree), scope);
      assert.deepEqual(actual, expected, `${name} ${JSON.stringify(args)}`);
      assert.ok(tree.requests.length > 0, `${name} asked the tree`);
      const noteListings = bucket.listings.filter((prefix) => !prefix.startsWith("."));
      assert.deepEqual(noteListings, [], `${name} listed the bucket at ${noteListings.join(", ")}`);
      // Front matter comes from the tree's props: the only notes a listing
      // tool opens are the one evaluate_lists was asked to evaluate, and the
      // front page orient shows whole.
      const read = new Set(["privacy.md", "index.md", "index-private.md", args.path]);
      const opened = bucket.gets.filter((key) => !key.startsWith(".") && !read.has(key));
      assert.deepEqual(opened, [], `${name} opened ${opened.join(", ")}`);
    }
  });
}

test("one call reads the tree once: later listings in it reuse what came back", async () => {
  const bucket = bucketOf(NOTES);
  const tree = treeOf(bucket, { pageSize: 100 });
  await callTool("orient", {}, served(bucket, tree), "private");
  assert.equal(tree.requests.filter((request) => request.ask === undefined).length, 1, "one manifest request");
});

test("a folder listing asks for that folder's subtree, a page at a time", async () => {
  const bucket = bucketOf(NOTES);
  const tree = treeOf(bucket, { pageSize: 1 });
  const store = servedListingStore(served(bucket, tree));
  const listed = await store.list({ prefix: "1-projects/" });
  assert.equal(listed.objects.length, 4);
  assert.ok(tree.requests.every(({ folder }) => folder === "1-projects"));
  assert.equal(tree.requests.length, 4);
  // A prefix that is not a whole folder name could match a sibling folder too,
  // so it is answered from its parent's subtree, never from a narrower one.
  tree.requests.length = 0;
  const fresh = servedListingStore(served(bucket, tree));
  await fresh.list({ prefix: "1-projects/al" });
  assert.ok(tree.requests.every(({ folder }) => folder === "1-projects"));
});

test("a key the tree wrongly sends is still held back by the gateway's own rules", async () => {
  const bucket = bucketOf(NOTES);
  // A tree that forgot the private rule: it sends everything to a team reader.
  const tree = treeOf(bucket, { see: () => true });
  const answer = await callTool("list_notes", {}, served(bucket, tree), "team");
  assert.doesNotMatch(answer.content[0].text, /2-areas\/health\.md/);
  assert.doesNotMatch(answer.content[0].text, /privacy\.md/);
  assert.match(answer.content[0].text, /1-projects\/beta\.md/);
});

test("the tree only narrows: a key it holds back is absent even where the bucket's rules allow it", async () => {
  const bucket = bucketOf(NOTES);
  const tree = treeOf(bucket, { see: (key) => key !== "1-projects/beta.md" });
  const answer = await callTool("list_notes", {}, served(bucket, tree), "private");
  assert.doesNotMatch(answer.content[0].text, /1-projects\/beta\.md/);
});

test("a workspace the tree does not serve is told it is still loading, and its bucket is not listed", async () => {
  for (const [name, args] of CALLS) {
    const bucket = bucketOf(NOTES);
    const tree = treeOf(bucket, { served: false });
    const answer = await callTool(name, args, served(bucket, tree), "private");
    if (name === "orient") {
      assert.ok(!answer.isError, "orient still answers");
      assert.match(answer.content[0].text, /still loading/);
    } else {
      assert.equal(answer.isError, true, `${name} says it cannot list`);
      assert.equal(answer.content[0].text, TREE_LOADING);
    }
    // Once per subtree asked side by side (list_channel_days asks for each
    // channel's folder at once), and never again after the refusal.
    const asked = tree.requests.filter((request) => request.ask === undefined).length;
    assert.ok(asked >= 1 && asked <= 3, `${name} asked ${asked} times`);
    assert.deepEqual(bucket.listings.filter((prefix) => !prefix.startsWith(".")), [], `${name} listed the bucket`);
  }
});

test("a failed request says so, and lists nothing", async () => {
  const bucket = bucketOf(NOTES);
  const tree = treeOf(bucket, { served: new Error("control plane timed out") });
  const answer = await callTool("list_notes", {}, served(bucket, tree), "team");
  assert.equal(answer.isError, true);
  assert.equal(answer.content[0].text, TREE_UNREACHABLE);
  assert.equal(tree.requests.length, 1);
  assert.deepEqual(bucket.listings.filter((prefix) => !prefix.startsWith(".")), []);
});

test("a tool outside the six never lists the bucket's keys; search's census is the tree's names; a new note asks the tree only for its name check", async () => {
  const bucket = bucketOf(NOTES);
  bucket.put = async (key, body) => {
    bucket.objects.set(key, { text: String(body), etag: "new", uploaded: Date.now() });
    return { key, etag: "new" };
  };
  // No facts route, so a write's chaos report (`chaos/change.js`, which asks
  // the tree for the score on purpose) stays out of this count of listings.
  const { facts: _facts, ...tree } = treeOf(bucket);
  await callTool("write_note", { path: "1-projects/gamma.md", content: "# Gamma\n" }, served(bucket, tree), "private");
  // A new note asks whether its name twins a sibling (`tree/twins.js`), of the tree and not the bucket.
  assert.ok(tree.requests.length >= 1, "the name check asked the tree");
  tree.requests.length = 0;
  await callTool("read_note", { path: "1-projects/beta.md" }, served(bucket, tree), "private");
  // Search is not one of the six, but its census (`search/shards/listing.js`) is the tree's names,
  // never the bucket's: in a keyed workspace the bucket lists uuid keys, not the names.
  await callTool("search_notes", { query: "alpha" }, served(bucket, tree), "private");
  assert.ok(tree.requests.length >= 1, "search asked the tree for the names it indexes");
  assert.deepEqual(bucket.listings.filter((prefix) => !prefix.startsWith(".")), [], "search never listed the bucket");
  for (const name of ["write_note", "move_note", "move_notes", "move_folder", "archive_note", "set_visibility"]) {
    assert.ok(!TREE_LISTING_TOOLS.has(name), `${name} lists the bucket it is about to change`);
  }
});

test("plumbing is listed from the bucket", async () => {
  const bucket = bucketOf(NOTES);
  const tree = treeOf(bucket);
  const store = servedListingStore(served(bucket, tree));
  const listed = await store.list({ prefix: ".context/" });
  assert.deepEqual(listed.objects.map(({ key }) => key), [".context/moves/state.json"]);
  assert.equal(tree.requests.length, 0);
});

test("a store with no control plane cannot list notes: there is no tree to ask, and the bucket is not walked", async () => {
  const bucket = bucketOf(NOTES);
  const store = servedListingStore(bucket);
  await assert.rejects(() => store.treeKeys(), (error) => error instanceof TreeUnavailable);
  await assert.rejects(() => store.list({}), (error) => error instanceof TreeUnavailable);
  assert.deepEqual(bucket.listings.filter((prefix) => !prefix.startsWith(".")), [], "the bucket was not walked");
});

test("listings page by key, and one level answers folders as delimited prefixes", async () => {
  const bucket = bucketOf(NOTES);
  const store = servedListingStore(served(bucket, treeOf(bucket, { pageSize: 100 })));
  const first = await store.list({ prefix: "1-projects/", limit: 2 });
  assert.deepEqual(first.objects.map(({ key }) => key), ["1-projects/about.md", "1-projects/alpha/notes.md"]);
  assert.equal(first.truncated, true);
  const second = await store.list({ prefix: "1-projects/", cursor: first.cursor, limit: 2 });
  assert.deepEqual(second.objects.map(({ key }) => key), ["1-projects/alpha/overview.md", "1-projects/beta.md"]);
  assert.equal(second.truncated, false);
  const level = await store.list({ prefix: "1-projects/", delimiter: "/" });
  assert.deepEqual(level.objects.map(({ key }) => key), ["1-projects/about.md", "1-projects/beta.md"]);
  assert.deepEqual(level.delimitedPrefixes, ["1-projects/alpha/"]);
  const dated = (await store.list({ prefix: "index" })).objects[0];
  assert.ok(dated.uploaded instanceof Date);
});

test("a manifest that repeats its cursor is not followed forever", async () => {
  const bucket = bucketOf(NOTES);
  let asked = 0;
  const store = servedListingStore(
    served(bucket, {
      manifest: async () => {
        asked += 1;
        return { served: true, entries: [{ path: "index.md" }], cursor: "index.md" };
      },
    })
  );
  await assert.rejects(store.list({ prefix: "" }), (error) => error instanceof TreeUnavailable && error.reason === "unreachable");
  assert.equal(asked, 2);
  assert.deepEqual(bucket.listings, [], "the bucket was not listed instead");
});

test("the control-plane call spends the person's token and names no scope", async () => {
  const { createTreeMethods } = await import("../src/controlPlane/tree.js");
  const sent = [];
  let answer = { served: true, entries: [{ path: "a.md" }], cursor: null };
  const methods = createTreeMethods({
    post: async (path, body) => {
      sent.push({ path, body });
      return answer;
    },
  });
  assert.deepEqual(await methods.readTreeManifest("tok", "ws_1", { folder: "1-projects", cursor: "1-projects/a.md" }), answer);
  assert.deepEqual(sent[0], {
    path: "/gateway/tree/manifest",
    body: { accessToken: "tok", expectedWorkspaceId: "ws_1", cursor: "1-projects/a.md", folder: "1-projects" },
  });
  answer = { served: false };
  assert.deepEqual(await methods.readTreeManifest("tok", "ws_1"), { served: false });
  answer = { served: true, entries: "nope", cursor: null };
  await assert.rejects(methods.readTreeManifest("tok", "ws_1"), /malformed tree manifest/);
});

test("a tree answer may be larger than the 256 KB every other control-plane answer is held to", async () => {
  const { createControlPlane } = await import("../src/controlPlane/index.js");
  const { CONTROL_PLANE_RESPONSE_BYTE_CAP } = await import("../src/controlPlane/client.js");
  // Five thousand names: past 256 KB, which refused every workspace of more
  // than about three thousand notes and sent it to the bucket (2026-10-13).
  const entries = Array.from({ length: 5000 }, (_, n) => ({ path: `1-projects/some-project/a-note-of-a-usual-length-${n}.md`, etag: `"${"0".repeat(32)}"`, size: 1000, updatedAt: 1 }));
  const big = JSON.stringify({ served: true, entries, cursor: null });
  assert.ok(big.length > CONTROL_PLANE_RESPONSE_BYTE_CAP);
  const controlPlane = createControlPlane(
    { CONTROL_PLANE_URL: "https://control.example", GATEWAY_SECRET: "test-secret" },
    { fetchImpl: async () => new Response(big, { status: 200, headers: { "Content-Type": "application/json" } }) },
  );
  const page = await controlPlane.readTreeManifest("tok", "ws_1", {});
  assert.equal(page.entries.length, 5000);
  // Every other route keeps the small cap.
  await assert.rejects(controlPlane.resolveSession("tok"), /response too large/);
});
