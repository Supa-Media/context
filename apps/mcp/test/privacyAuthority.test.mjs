/**
 * `privacy.md` as the export of the control plane's rules (phase 3 of
 * `docs/decisions/app-and-console/convex-tree.md`): the store seam in
 * `src/store/privacyAuthority.js`, driven through the same privacy code every
 * tool uses, against a fake authority that keeps the control plane's
 * compare-and-swap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPrivacyAuthority, rulesOfText, renderWithRules } from "../src/store/privacyAuthority.js";
import { loadPrivacyState, persistExactVisibility } from "../src/privacy/state.js";
import { PRIVACY_KEY, canSee, effectiveVisibility } from "../src/privacy/engine.js";

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
    this.failPuts = false;
  }
  seed(key, text) {
    this.objects.set(key, { text, etag: `e${++this.counter}` });
  }
  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return { etag: item.etag, text: async () => item.text };
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag } : null;
  }
  async put(key, value, options = {}) {
    if (this.failPuts) throw new Error("bucket refused");
    const current = this.objects.get(key);
    if (options.onlyIf?.absent === true && current) return null;
    if (options.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, { text, etag: `e${++this.counter}` });
    return { etag: `e${this.counter}` };
  }
  async copy(source, destination, options) {
    const item = this.objects.get(source);
    return item ? await this.put(destination, item.text, options) : null;
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, item]) => ({ key, etag: item.etag }));
    return { objects, truncated: false };
  }
}

const manifest = (folders, notes, prose = "# Privacy\n\nWho sees what.\n\n") =>
  `${prose}<!-- BEGIN BRAIN PRIVACY RULES -->\n\n\`\`\`yaml\ndefault_visibility: private\n\nfolder_defaults:\n${
    folders.map(([prefix, vis]) => `  ${prefix}: ${vis}`).join("\n") || "  # none"
  }\n\nnote_overrides:\n${
    notes.map(([path, vis]) => `  ${path}: ${vis}`).join("\n") || "  # none"
  }\n\`\`\`\n\n<!-- END BRAIN PRIVACY RULES -->\n`;

/** The control plane's side, as `functions/nodesPrivacy.ts` keeps it. */
function fakeAuthority(rules) {
  const calls = [];
  let version = 0;
  const state = { rules };
  return {
    calls,
    state,
    get rules() {
      return state.rules;
    },
    async write(change) {
      calls.push(["write", change]);
      if (change.expected !== null && change.expected !== state.rules.etag) return { current: state.rules };
      state.rules = { etag: `ctx-${++version}`, folders: change.folders, notes: change.notes };
      return { etag: state.rules.etag };
    },
    async written(change) {
      calls.push(["written", change]);
    },
    async exported(done) {
      calls.push(["exported", done]);
    },
    async owed() {
      calls.push(["owed"]);
    },
  };
}

const held = (folders, notes, etag = "ctx-0") => ({
  etag,
  folders: folders.map(([prefix, visibility]) => ({ prefix, visibility })),
  notes: notes.map(([path, visibility]) => ({ path, visibility })),
});

test("no authority leaves the store exactly as it was", () => {
  const store = new MemoryStore();
  assert.equal(withPrivacyAuthority(store, null), store);
  assert.equal(withPrivacyAuthority(store, undefined), store);
});

test("while the file is the authority, a write of it is reported from the version it replaced", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(null);
  const store = withPrivacyAuthority(bucket, authority);

  await persistExactVisibility(store, "1-projects/plan.md", "private", []);
  const written = authority.calls.filter(([name]) => name === "written");
  assert.equal(written.length, 1);
  assert.equal(written[0][1].previous, "e1");
  assert.equal(written[0][1].etag, "e2");
  assert.deepEqual(written[0][1].notes, [{ path: "1-projects/plan.md", visibility: "private" }]);
  // The file is the bucket's own, untouched by the wrapper.
  assert.equal((await store.get(PRIVACY_KEY)).etag, "e2");
});

test("a file that does not parse is never reported as rules", async () => {
  const bucket = new MemoryStore();
  const authority = fakeAuthority(null);
  const store = withPrivacyAuthority(bucket, authority);
  await store.put(PRIVACY_KEY, "# no block here\n");
  assert.deepEqual(authority.calls, []);
});

test("reading privacy.md answers the held rules, not a rule edited into the file past them", async () => {
  const bucket = new MemoryStore();
  // Someone made a private folder team in the file by hand.
  bucket.seed(PRIVACY_KEY, manifest([["2-areas/finance", "team"]], [], "# Our privacy\n\nKept by hand.\n\n"));
  const store = withPrivacyAuthority(bucket, fakeAuthority(held([["1-projects", "team"]], [["1-projects/secret.md", "private"]])));

  const object = await store.get(PRIVACY_KEY);
  assert.equal(object.etag, "ctx-0");
  const text = await object.text();
  assert.match(text, /^# Our privacy\n\nKept by hand\./);
  const state = await loadPrivacyState(store);
  assert.equal(state.error, undefined);
  assert.equal(effectiveVisibility("2-areas/finance/q3.md", state.rules, state.overrides), "private");
  assert.equal(canSee("2-areas/finance/q3.md", "team", state.rules, state.overrides), false);
  assert.equal(canSee("1-projects/plan.md", "team", state.rules, state.overrides), true);
  assert.equal(canSee("1-projects/secret.md", "team", state.rules, state.overrides), false);
  assert.deepEqual(await store.head(PRIVACY_KEY), { etag: "ctx-0" });
});

test("a missing or broken file still reads as the held rules", async () => {
  const rules = held([["1-projects", "team"]], []);
  const missing = withPrivacyAuthority(new MemoryStore(), fakeAuthority(rules));
  const fromNothing = await loadPrivacyState(missing);
  assert.equal(fromNothing.legacy, false);
  assert.deepEqual(fromNothing.rules, [{ prefix: "1-projects", vis: "team" }]);

  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, "# Mine\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\nnot yaml at all\n<!-- END BRAIN PRIVACY RULES -->\n");
  const broken = await loadPrivacyState(withPrivacyAuthority(bucket, fakeAuthority(rules)));
  assert.equal(broken.error, undefined);
  assert.match(broken.text, /^# Mine/);
  assert.deepEqual(broken.rules, [{ prefix: "1-projects", vis: "team" }]);
});

test("a change is a compare-and-swap on the held version, then the file is exported", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);

  await persistExactVisibility(store, "1-projects/plan.md", "private", []);
  const [write] = authority.calls.filter(([name]) => name === "write");
  assert.equal(write[1].expected, "ctx-0");
  assert.deepEqual(write[1].notes, [{ path: "1-projects/plan.md", visibility: "private" }]);
  assert.deepEqual(authority.calls.find(([name]) => name === "exported")[1], { rendered: "ctx-1", etag: "e2" });
  // The bucket holds the export, and a read answers the new version.
  assert.deepEqual(rulesOfText(bucket.objects.get(PRIVACY_KEY).text).notes, [
    { path: "1-projects/plan.md", visibility: "private" },
  ]);
  assert.equal((await store.get(PRIVACY_KEY)).etag, "ctx-1");
});

test("a write from a stale version loses, as it would against the bucket", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([], []));
  const authority = fakeAuthority(held([], []));
  const store = withPrivacyAuthority(bucket, authority);
  const result = await store.put(PRIVACY_KEY, manifest([["1-projects", "team"]], []), { onlyIf: { etagMatches: "ctx-old" } });
  assert.equal(result, null);
  // Nor does the bucket's own etag pass for the held version.
  assert.equal(await store.put(PRIVACY_KEY, manifest([], []), { onlyIf: { etagMatches: "e1" } }), null);
  assert.equal(await store.put(PRIVACY_KEY, manifest([], []), { onlyIf: { absent: true } }), null);
  assert.equal(authority.state.rules.etag, "ctx-0");
  assert.equal(bucket.objects.get(PRIVACY_KEY).etag, "e1");
});

test("a change made elsewhere first is read and built on, not lost", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);
  // Another request makes 2-areas team after this store read the rules.
  authority.state.rules = held([["1-projects", "team"], ["2-areas", "team"]], [], "ctx-9");
  await persistExactVisibility(store, "1-projects/plan.md", "private", []);
  const state = await loadPrivacyState(store);
  assert.deepEqual(state.rules.map((rule) => rule.prefix).sort(), ["1-projects", "2-areas"]);
  assert.equal(state.overrides.get("1-projects/plan.md"), "private");
});

test("a text without readable rules is refused, and changes nothing", async () => {
  const bucket = new MemoryStore();
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);
  await assert.rejects(store.put(PRIVACY_KEY, "# Privacy\n\nall gone\n"), /managed rules block/);
  assert.deepEqual(authority.calls, []);
  assert.equal(bucket.objects.size, 0);
});

test("an export the bucket refuses is owed, and the change still stands", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([], []));
  const authority = fakeAuthority(held([], []));
  const store = withPrivacyAuthority(bucket, authority);
  bucket.failPuts = true;
  const result = await store.put(PRIVACY_KEY, manifest([["1-projects", "team"]], []), { onlyIf: { etagMatches: "ctx-0" } });
  assert.deepEqual(result, { etag: "ctx-1" });
  assert.ok(authority.calls.some(([name]) => name === "owed"));
  assert.ok(!authority.calls.some(([name]) => name === "exported"));
  bucket.failPuts = false;
  // The retry writes the file from the rules.
  assert.deepEqual(await store.exportPrivacy(), { rendered: "ctx-1", etag: "e2" });
  assert.deepEqual(rulesOfText(bucket.objects.get(PRIVACY_KEY).text).folders, [{ prefix: "1-projects", visibility: "team" }]);
});

test("the prose of the text written is what is exported", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([], [], "# Old words\n\n"));
  const store = withPrivacyAuthority(bucket, fakeAuthority(held([], [])));
  await store.put(PRIVACY_KEY, manifest([], [], "# New words\n\n"), { onlyIf: { etagMatches: "ctx-0" } });
  assert.match(bucket.objects.get(PRIVACY_KEY).text, /^# New words/);
});

test("deleting privacy.md removes no rule, and copying over it is refused", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  bucket.seed("other.md", manifest([["2-areas", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);
  await store.delete(PRIVACY_KEY);
  assert.ok(authority.calls.some(([name]) => name === "owed"));
  assert.deepEqual((await loadPrivacyState(store)).rules, [{ prefix: "1-projects", vis: "team" }]);
  await assert.rejects(store.copy("other.md", PRIVACY_KEY), /not copied over/);
});

test("every other key, and every listing, is the bucket's own", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([], []));
  bucket.seed("1-projects/a.md", "hello");
  const authority = fakeAuthority(held([], []));
  const store = withPrivacyAuthority(bucket, authority);
  assert.equal(await (await store.get("1-projects/a.md")).text(), "hello");
  await store.put("1-projects/b.md", "there");
  assert.equal(bucket.objects.get("1-projects/b.md").text, "there");
  // The listing's version for privacy.md is the bucket's, which is how an edit past the rules shows.
  const listed = (await store.list({})).objects.find((object) => object.key === PRIVACY_KEY);
  assert.equal(listed.etag, "e1");
  assert.deepEqual(authority.calls, []);
});

test("renderWithRules keeps the prose and replaces only the block", () => {
  const text = renderWithRules(manifest([["x", "team"]], [], "# Kept\n\n"), held([["y", "team"]], []));
  assert.match(text, /^# Kept/);
  assert.deepEqual(rulesOfText(text).folders, [{ prefix: "y", visibility: "team" }]);
  assert.deepEqual(rulesOfText(renderWithRules(null, held([], []))), { folders: [], notes: [] });
});
