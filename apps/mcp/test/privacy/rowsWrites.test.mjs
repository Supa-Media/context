/**
 * Privacy writes (`accessVersion` in the held rules): a tier is one row's `setAccess` on the control plane, from the
 * version held, and privacy.md is never written. There is no file mode any more.
 *
 * Sabotage: make `setRowTier` call `authority.write` instead of `setAccess` and the "calls setAccess, never
 * write" tests fail; drop the held update and the "later check sees it" test fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPrivacyAuthority } from "../../src/store/privacyAuthority.js";
import {
  clearExactVisibility,
  loadPrivacyState,
  PRIVACY_CONCURRENT_ERROR,
  persistExactVisibility,
  RowsWriteRefused,
} from "../../src/privacy/state.js";
import { canSee, PRIVACY_KEY, PRIVACY_RULES_BEGIN, PRIVACY_RULES_END } from "../../src/privacy/engine.js";
import { toolSetFolderVisibility, toolSetVisibility } from "../../src/tools/visibility.js";
import { withServedTree } from "../servedTree.mjs";

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
    this.puts = [];
  }
  seed(key, text) {
    this.objects.set(key, { text, etag: `e${++this.counter}` });
  }
  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      etag: item.etag,
      text: async () => item.text,
      arrayBuffer: async () => new TextEncoder().encode(item.text).buffer,
    };
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag } : null;
  }
  async list() {
    return { objects: [], truncated: false };
  }
  async put(key, value) {
    this.puts.push(key);
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, { text, etag: `e${++this.counter}` });
    return { etag: `e${this.counter}` };
  }
  async delete(key) {
    this.objects.delete(key);
  }
}

const FILE = [
  "# Privacy",
  "",
  PRIVACY_RULES_BEGIN,
  "",
  "```yaml",
  "default_visibility: private",
  "",
  "folder_defaults:",
  "  1-projects: team",
  "",
  "note_overrides:",
  "  # none",
  "```",
  "",
  PRIVACY_RULES_END,
  "",
].join("\n");

/**
 * The control plane's authority as a rows-mode gateway holds it: the rules rendered from the rows, the version
 * of the rows beside the file's etag. `write` is recorded so a test can say it was never called.
 */
function rowsAuthority(answer = (change) => ({ ok: true, version: change.expectedVersion + 1 })) {
  const calls = { setAccess: [], write: [] };
  return {
    calls,
    rules: {
      etag: "ctx-rows-1",
      folders: [{ prefix: "1-projects", visibility: "team" }],
      notes: [],
      accessVersion: 7,
    },
    async setAccess(change) {
      calls.setAccess.push(change);
      return answer(change);
    },
  };
}

test("privacy.md is never written from the rows: a write of it is refused, and nothing is exported", async () => {
  // Sabotage: let `put` pass privacy.md through to the bucket and `memory.puts` gains `privacy.md`.
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  await assert.rejects(store.put(PRIVACY_KEY, FILE, { onlyIf: { etagMatches: "ctx-rows-1" } }), {
    code: "PRIVACY_MANIFEST_READ_ONLY",
  });
  assert.deepEqual(memory.puts, [], "privacy.md is not written in rows mode");
  assert.deepEqual(authority.calls.write, []);
});

test("rows mode: a note's tier is one setAccess from the held version, and the bucket's privacy.md is not written", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  assert.ok(store.rowAccess, "rows mode exposes the row write");

  const state = await loadPrivacyState(store);
  await persistExactVisibility(store, "1-projects/a.md", "private", state.rules);

  assert.deepEqual(authority.calls.write, [], "rules are never written in rows mode");
  assert.deepEqual(memory.puts, [], "the bucket's file is not written either");
  assert.deepEqual(authority.calls.setAccess, [{ path: "1-projects/a.md", base: "private", expectedVersion: 7 }]);
});

test("rows mode: a tier equal to what the note inherits is the row's inherit, not a second copy of the folder", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  const state = await loadPrivacyState(store);
  await persistExactVisibility(store, "1-projects/a.md", "team", state.rules);
  await clearExactVisibility(store, "1-projects/a.md");
  assert.deepEqual(
    authority.calls.setAccess.map((call) => call.base),
    ["inherit", "inherit"],
  );
});

test("rows mode: the in-request rules see a write made earlier in the same request", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  await persistExactVisibility(store, "1-projects/a.md", "private", (await loadPrivacyState(store)).rules);

  const later = await loadPrivacyState(store);
  assert.equal(later.overrides.get("1-projects/a.md"), "private", "the override is held for later checks");
  assert.equal(canSee("1-projects/a.md", "team", later.rules, later.overrides, new Set()), false);
  assert.equal(canSee("1-projects/b.md", "team", later.rules, later.overrides, new Set()), true);
});

test("rows mode: the held version moves with each write, so the next one is checked against it", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  await persistExactVisibility(store, "1-projects/a.md", "private", (await loadPrivacyState(store)).rules);
  await persistExactVisibility(store, "1-projects/b.md", "private", (await loadPrivacyState(store)).rules);
  assert.deepEqual(
    authority.calls.setAccess.map((call) => call.expectedVersion),
    [7, 8],
  );
});

test("rows mode: a CONFLICT is the file's conflict text, and FORBIDDEN is a refusal with its code", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const conflict = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "CONFLICT" })));
  await assert.rejects(
    persistExactVisibility(conflict, "1-projects/a.md", "private", (await loadPrivacyState(conflict)).rules),
    (error) => error.message === PRIVACY_CONCURRENT_ERROR,
  );

  const forbidden = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "FORBIDDEN" })));
  await assert.rejects(
    persistExactVisibility(forbidden, "1-projects/a.md", "private", (await loadPrivacyState(forbidden)).rules),
    (error) => error instanceof RowsWriteRefused && error.code === "FORBIDDEN",
  );
});

test("rows mode: clearing a row that is gone (moved away) is nothing to clear, and a refused clear is an error", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const gone = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "NOT_FOUND" })));
  await clearExactVisibility(gone, "1-projects/moved.md");

  const refused = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "FORBIDDEN" })));
  await assert.rejects(clearExactVisibility(refused, "1-projects/a.md"), (error) => error.code === "FORBIDDEN");
});

test("rows mode: a private new note asks for its tier before its row exists, and the ask is held, not refused", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  // The control plane keeps the ask as pending access for a path with no row, and answers ok at the next version.
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  const path = "1-projects/brand-new.md";
  await persistExactVisibility(store, path, "private", (await loadPrivacyState(store)).rules);

  assert.deepEqual(authority.calls.setAccess, [{ path, base: "private", expectedVersion: 7 }]);
  assert.equal((await loadPrivacyState(store)).overrides.get(path), "private", "held for the rest of the request");
});

test("rows mode: a folder's tier with no row says it is a folder, so its pending access is the folder's", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  await store.rowAccess.setTier("3-site", "team", { folder: true });
  assert.deepEqual(authority.calls.setAccess, [{ path: "3-site", base: "team", expectedVersion: 7, kind: "folder" }]);
});

test("rows mode: a waiting list that is full is refused with its code", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  const full = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "PENDING_FULL" })));
  await assert.rejects(
    persistExactVisibility(full, "1-projects/a.md", "private", (await loadPrivacyState(full)).rules),
    (error) => error instanceof RowsWriteRefused && error.code === "PENDING_FULL",
  );
});

test("rows mode: set_visibility calls setAccess, answers the permission error on FORBIDDEN, and writes no file", async () => {
  const memory = new MemoryStore();
  memory.seed(PRIVACY_KEY, FILE);
  memory.seed("1-projects/a.md", "# A\n");
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  const state = await loadPrivacyState(store);
  const result = await toolSetVisibility(store, "private", state.rules, state.overrides, {
    path: "1-projects/a.md",
    visibility: "private",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(authority.calls.write, []);
  assert.equal(authority.calls.setAccess.length, 1);
  assert.equal(authority.calls.setAccess[0].base, "private");

  const denied = withPrivacyAuthority(memory, rowsAuthority(() => ({ ok: false, code: "FORBIDDEN" })));
  const refused = await toolSetVisibility(denied, "private", state.rules, state.overrides, {
    path: "1-projects/a.md",
    visibility: "private",
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /permission denied: note/);
});

test("rows mode: set_folder_visibility sets the folder's own row and writes no rules", async () => {
  const memory = withServedTree(new MemoryStore());
  memory.seed(PRIVACY_KEY, FILE);
  const authority = rowsAuthority();
  const store = withPrivacyAuthority(memory, authority);
  const result = await toolSetFolderVisibility(store, "private", {
    path: "2-areas",
    visibility: "private",
    expected_privacy_etag: "ctx-rows-1",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(authority.calls.write, []);
  assert.deepEqual(memory.puts.filter((key) => key === PRIVACY_KEY), []);
  // A folder says so: a path with no row takes its pending access as the folder's row.
  assert.deepEqual(authority.calls.setAccess, [{ path: "2-areas", base: "private", expectedVersion: 7, kind: "folder" }]);
});
