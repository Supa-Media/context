/**
 * The access rules as the store serves them (`src/store/privacyAuthority.js`): the control plane's rows, rendered
 * for the reader, with `privacy.md` never read from or written to the bucket. A write of the file is refused, and a
 * row's tier goes through the control plane's `setAccess` from the version held. Driven through the same privacy code
 * every tool uses, against a fake authority that keeps the control plane's compare-and-swap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
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

const manifest = (folders, notes) =>
  `# Privacy\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n\`\`\`yaml\ndefault_visibility: private\n\nfolder_defaults:\n${
    folders.map(([prefix, vis]) => `  ${prefix}: ${vis}`).join("\n") || "  # none"
  }\n\nnote_overrides:\n${
    notes.map(([path, vis]) => `  ${path}: ${vis}`).join("\n") || "  # none"
  }\n\`\`\`\n\n<!-- END BRAIN PRIVACY RULES -->\n`;

/** The control plane's side as the store sees it: the rules it renders, and one row change answered at the next version. */
function fakeAuthority(rules) {
  const calls = [];
  let version = rules.accessVersion;
  return {
    calls,
    rules,
    async setAccess(change) {
      calls.push(["setAccess", change]);
      version += 1;
      return { ok: true, version };
    },
    async addGrantees(change) {
      calls.push(["addGrantees", change]);
      version += 1;
      return { ok: true, version };
    },
  };
}

const held = (folders, notes, etag = "ctx-0", accessVersion = 7) => ({
  etag,
  accessVersion,
  folders: folders.map(([prefix, visibility]) => ({ prefix, visibility })),
  notes: notes.map(([path, visibility]) => ({ path, visibility })),
});

test("no authority leaves the store exactly as it was", () => {
  const store = new MemoryStore();
  assert.equal(withPrivacyAuthority(store, null), store);
  assert.equal(withPrivacyAuthority(store, undefined), store);
});

test("privacy.md is never written, deleted or copied over: each is refused, and nothing reaches the authority", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  bucket.seed("other.md", manifest([["2-areas", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);

  await assert.rejects(store.put(PRIVACY_KEY, manifest([], []), { onlyIf: { etagMatches: "ctx-0" } }), {
    code: "PRIVACY_MANIFEST_READ_ONLY",
  });
  await assert.rejects(store.delete(PRIVACY_KEY), { code: "PRIVACY_MANIFEST_READ_ONLY" });
  await assert.rejects(store.copy("other.md", PRIVACY_KEY), { code: "PRIVACY_MANIFEST_READ_ONLY" });
  assert.deepEqual(authority.calls, []);
  assert.equal(bucket.objects.get(PRIVACY_KEY).text, manifest([["1-projects", "team"]], []));
  // The rules are still the held ones: a delete removed no rule.
  assert.deepEqual((await loadPrivacyState(store)).rules, [{ prefix: "1-projects", vis: "team" }]);
});

test("reading privacy.md answers the held rules, not a rule edited into the file past them", async () => {
  const bucket = new MemoryStore();
  // Someone made a private folder team in the file by hand.
  bucket.seed(PRIVACY_KEY, manifest([["2-areas/finance", "team"]], []));
  const store = withPrivacyAuthority(bucket, fakeAuthority(held([["1-projects", "team"]], [["1-projects/secret.md", "private"]])));

  const object = await store.get(PRIVACY_KEY);
  assert.equal(object.etag, "ctx-0");
  assert.match(await object.text(), /BEGIN BRAIN PRIVACY RULES/);
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
  assert.deepEqual(broken.rules, [{ prefix: "1-projects", vis: "team" }]);
});

test("a row change is one setAccess from the held version, and the next one is checked against the new version", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  const store = withPrivacyAuthority(bucket, authority);

  await persistExactVisibility(store, "1-projects/plan.md", "private");
  await persistExactVisibility(store, "1-projects/other.md", "private");
  assert.deepEqual(authority.calls, [
    ["setAccess", { path: "1-projects/plan.md", base: "private", expectedVersion: 7 }],
    ["setAccess", { path: "1-projects/other.md", base: "private", expectedVersion: 8 }],
  ]);
  // The row is held for the rest of the request, and the bucket's file is untouched.
  const state = await loadPrivacyState(store);
  assert.equal(state.overrides.get("1-projects/plan.md"), "private");
  assert.equal(bucket.objects.get(PRIVACY_KEY).text, manifest([["1-projects", "team"]], []));
});

test("a row change the control plane refuses as a conflict is the file's conflict text, and changes nothing held", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], []));
  authority.setAccess = async (change) => {
    authority.calls.push(["setAccess", change]);
    return { ok: false, code: "CONFLICT" };
  };
  const store = withPrivacyAuthority(bucket, authority);
  await assert.rejects(persistExactVisibility(store, "1-projects/plan.md", "private"), (error) =>
    error.message.includes("privacy manifest changed concurrently"),
  );
  assert.equal((await loadPrivacyState(store)).overrides.get("1-projects/plan.md"), undefined);
  // The one retry without the version is also refused, so nothing else is tried.
  assert.equal(authority.calls.length, 2);
});

test("another row's change since the request began is one retry without the version, and the held etag moves", async () => {
  const bucket = new MemoryStore();
  bucket.seed(PRIVACY_KEY, manifest([["1-projects", "team"]], []));
  const authority = fakeAuthority(held([["1-projects", "team"]], [], "mirror-1.7"));
  const answer = authority.setAccess;
  authority.setAccess = async (change) => {
    if (change.expectedVersion === undefined) return await answer({ ...change });
    authority.calls.push(["setAccess", change]);
    return { ok: false, code: "CONFLICT" };
  };
  const store = withPrivacyAuthority(bucket, authority);
  assert.equal((await loadPrivacyState(store)).etag, "mirror-1.7");
  await persistExactVisibility(store, "1-projects/plan.md", "private");
  assert.deepEqual(authority.calls, [
    ["setAccess", { path: "1-projects/plan.md", base: "private", expectedVersion: 7 }],
    ["setAccess", { path: "1-projects/plan.md", base: "private" }],
  ]);
  const state = await loadPrivacyState(store);
  assert.equal(state.overrides.get("1-projects/plan.md"), "private");
  // The control plane's etag is `<mirror>.<version>`: a preflight taken now matches the next request's.
  assert.equal(state.etag, "mirror-1.8");
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

test("recording what the rows already say sends the row's inherit, and a real change that fails still fails", async () => {
  // save_context and write_note record `team` after every team write. In a team folder that changes nothing: the
  // row goes back to inherit, and nothing is copied into a second row beside the folder.
  for (const rules of [held([["0-inbox", "team"]], []), held([["0-inbox", "team"]], [["0-inbox/held.md", "private"]])]) {
    const bucket = new MemoryStore();
    bucket.seed(PRIVACY_KEY, manifest([["0-inbox", "team"]], []));
    const authority = fakeAuthority(rules);
    const store = withPrivacyAuthority(bucket, authority);
    await persistExactVisibility(store, "0-inbox/sessions/claude/new.md", "team");
    assert.deepEqual(authority.calls.at(-1), [
      "setAccess",
      { path: "0-inbox/sessions/claude/new.md", base: "inherit", expectedVersion: 7 },
    ]);
    // A real change still asks, and still fails loudly when the control plane refuses it.
    authority.setAccess = async () => ({ ok: false, code: "FORBIDDEN" });
    await assert.rejects(persistExactVisibility(store, "0-inbox/held.md", "team"), (error) => error.code === "FORBIDDEN");
  }
});

/*
  @shyoh, 2026-10-19: every read of one workspace failed with "Your bucket did
  not complete that request". The held rules named a row the file's parser
  refuses (a non-Markdown note, a `#` in a name, a dot folder), so rendering
  privacy.md for a read threw "would not read back" and took every read with
  it. A read serves the held rules as they are; only a write of the file
  still refuses rules it could not read back.

  Sabotage: render reads through `renderWithRules` again and this fails.
*/
test("held rules the file cannot spell still read, exactly as held", async () => {
  const rules = held(
    [["1-projects", "team"], [".obsidian", "private"]],
    [["1-projects/cat.png", "private"], ["1-projects/C# notes.md", "private"]],
  );
  const store = withPrivacyAuthority(new MemoryStore(), fakeAuthority(rules));
  const state = await loadPrivacyState(store);
  assert.equal(canSee("1-projects/plan.md", "team", state.rules, state.overrides), true);
  assert.equal(canSee("1-projects/cat.png", "team", state.rules, state.overrides), false);
  assert.equal(canSee("1-projects/C# notes.md", "team", state.rules, state.overrides), false);
  assert.equal(effectiveVisibility(".obsidian/app.json", state.rules, state.overrides), "private");
  assert.match(await (await store.get(PRIVACY_KEY)).text(), /BEGIN BRAIN PRIVACY RULES/);
});
