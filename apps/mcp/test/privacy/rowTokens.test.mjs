/**
 * Row tokens through the gateway (the access-rows switch, `accessSource: rows`).
 *
 * The control plane renders a row's grant list as `@#<noteId>` and hands it to
 * the gateway as the authority's rules, and a grant carries the same name as
 * `#<noteId>`. Both must survive the gateway unchanged, and nothing may let a
 * token into `privacy.md`: the parser keeps refusing it in file text, so file
 * mode reads exactly as it did.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPrivacyAuthority } from "../../src/store/privacyAuthority.js";
import { loadPrivacyState, persistExactVisibility } from "../../src/privacy/state.js";
import { canSee, PRIVACY_KEY, PRIVACY_RULES_BEGIN, PRIVACY_RULES_END } from "../../src/privacy/engine.js";
import { ROW_NAME_PATTERN, ROW_TOKEN_PATTERN, tokenFor } from "../../src/privacy/rowAccess.js";
import { accessForLiveGrant, SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE } from "../../src/session.js";

const NOTE = "note0001abcd";
const TOKEN = tokenFor(NOTE);
const WORKSPACE = "ws_rows";
const NOTE_NAME = `#${NOTE}`;

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
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
  async put(key, value) {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, { text, etag: `e${++this.counter}` });
    return { etag: `e${this.counter}` };
  }
}

/** A privacy.md the way the bucket holds it: prose and a managed block. */
function fileWithBlock(folderLines, noteLines = []) {
  return [
    "# Privacy",
    "",
    PRIVACY_RULES_BEGIN,
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    ...(folderLines.length ? folderLines : ["  # none"]),
    "",
    "note_overrides:",
    ...(noteLines.length ? noteLines : ["  # none"]),
    "```",
    "",
    PRIVACY_RULES_END,
    "",
  ].join("\n");
}

/** An authority holding these rules, as `nodesPrivacy.authority` returns them. */
function authorityHolding(rules) {
  return { rules, write: async () => null, written: async () => {}, exported: async () => {}, owed: async () => {} };
}

const HELD = {
  etag: "ctx-rows-1",
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "2-areas", visibility: TOKEN },
  ],
  notes: [{ path: "1-projects/keep.md", visibility: TOKEN }],
};

test("a row token in the held rules is judged as the rule says: granted names open it, nothing else does", async () => {
  const store = new MemoryStore();
  store.seed(PRIVACY_KEY, fileWithBlock(["  1-projects: team"]));
  const wrapped = withPrivacyAuthority(store, authorityHolding(HELD));
  const state = await loadPrivacyState(wrapped);
  assert.equal(state.error, undefined, "the held rules must load, not fail closed");
  assert.deepEqual(state.rules, [
    { prefix: "1-projects", vis: "team" },
    { prefix: "2-areas", vis: TOKEN },
  ]);
  assert.equal(state.overrides.size, 1);

  const granted = new Set([TOKEN]);
  // Folder rule with a token: visible to the grantee, private to everyone else.
  assert.equal(canSee("2-areas/a.md", "team", state.rules, state.overrides, granted), true);
  assert.equal(canSee("2-areas/a.md", "team", state.rules, state.overrides, new Set()), false);
  // Exact-note override with a token: the same, and the team folder around it does not reach it.
  assert.equal(canSee("1-projects/keep.md", "team", state.rules, state.overrides, granted), true);
  assert.equal(canSee("1-projects/keep.md", "team", state.rules, state.overrides, new Set()), false);
  // A team folder is still team.
  assert.equal(canSee("1-projects/other.md", "team", state.rules, state.overrides, new Set()), true);
});

test("file mode is unchanged: a row token written in privacy.md is still refused, failing closed", async () => {
  const store = new MemoryStore();
  store.seed(PRIVACY_KEY, fileWithBlock([`  2-areas: ${TOKEN}`]));
  const state = await loadPrivacyState(store);
  // The parser strips `#` comments, so the token line reads as a broken rule: refused either way.
  assert.match(state.error ?? "", /invalid privacy rule/);
  assert.deepEqual(state.rules, []);
});

test("a row token never reaches privacy.md: export, a rule write and a file write are all refused", async () => {
  const store = new MemoryStore();
  const original = fileWithBlock(["  1-projects: team"]);
  store.seed(PRIVACY_KEY, original);
  const wrapped = withPrivacyAuthority(store, authorityHolding(HELD));

  await assert.rejects(wrapped.exportPrivacy(), /not written from access rows/);

  const state = await loadPrivacyState(wrapped);
  await assert.rejects(
    persistExactVisibility(wrapped, "1-projects/other.md", "team", state.rules),
    /would not read back/,
  );

  const text = await (await store.get(PRIVACY_KEY)).text();
  assert.equal(text, original, "the bucket's privacy.md is untouched");
  assert.ok(!text.includes("@#"), "no token in the bucket's file");
});

test("a grant's row name is accepted at the grant boundary, as the token form, and a malformed one is not", () => {
  const grant = (grantedNames) => ({
    grantId: "grant_rows",
    workspaceId: WORKSPACE,
    scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE],
    role: "owner",
    kind: "personal",
    grantedNames,
  });

  const access = accessForLiveGrant(grant([NOTE_NAME]), WORKSPACE);
  assert.ok(access, "a row name must not fail the whole grant");
  assert.ok(access.grantedGroups.has(TOKEN), "the caller holds the row's token");

  const editing = accessForLiveGrant(grant([`${NOTE_NAME}!edit`]), WORKSPACE);
  assert.ok(editing?.grantedGroups.has(`${TOKEN}!edit`));

  // A group name still works beside it.
  const both = accessForLiveGrant(grant([NOTE_NAME, "acme-leads"]), WORKSPACE);
  assert.ok(both?.grantedGroups.has("@acme-leads"));

  assert.equal(accessForLiveGrant(grant(["#short"]), WORKSPACE), null);
  assert.equal(accessForLiveGrant(grant([`${NOTE_NAME}/../x`]), WORKSPACE), null);
});

test("the token patterns accept what rows render and nothing else", () => {
  assert.match(TOKEN, ROW_TOKEN_PATTERN);
  assert.doesNotMatch("@#NOTE0001ABCD", ROW_TOKEN_PATTERN);
  assert.doesNotMatch("@acme-leads", ROW_TOKEN_PATTERN);
  assert.match(NOTE_NAME, ROW_NAME_PATTERN);
  assert.doesNotMatch(TOKEN, ROW_NAME_PATTERN);
});

