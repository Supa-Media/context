/**
 * THE FORWARDING LEDGER AND THE FOLDER ICONS, HELD BY THE CONTROL PLANE.
 *
 * Since 2026-10-14 a gateway with a control plane never reads
 * `.context/forwarding.json` or `.context/folder-icons.json` back
 * (`docs/decisions/app-and-console/convex-small-data.md`). The store carries
 * two hooks (`controlPlane/changeReporters.js`): the ledger is read from
 * `/gateway/tree/facts` already filtered to the grant, and a move is recorded
 * through `/gateway/tree/touch`. A gateway with no control plane — a
 * self-hosted one, the suite's stub — keeps the file as the record, which
 * `forwarding.test.mjs` and `folderIcons.test.mjs` go on proving.
 *
 * What is proved here:
 *  - with the hooks, nothing GETs either file, and moves are recorded through
 *    the control plane, cleaned, in batches the route accepts;
 *  - a store with no token to ask with (a queued job) reads an empty ledger,
 *    never the bucket's file;
 *  - an entry the control plane answers with `to: null` — moved somewhere the
 *    reader may not see — forwards to nothing: `read_note` answers exactly as
 *    for a path that never existed, and an activity line about it is absent;
 *  - an answer is data: anything malformed in it is dropped.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `forwardOnce` following a hidden entry as if it had no `to`
 *    (`HIDDEN` removed): "a trail into a hidden place is not found" fails;
 *  - `readForwarding` ignoring the hook: "with the hooks, neither file is
 *    read" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { attachChangeReporters } from "../src/controlPlane/changeReporters.js";
import { createTreeMethods, SMALL_DATA_BATCH } from "../src/controlPlane/tree.js";
import {
  FORWARDING_PATH,
  forwardPath,
  readForwarding,
  recordForwarding,
  serializeForwarding,
  servedForwarding,
} from "../src/forwarding.js";
import { toolReadNote } from "../src/tools/notes/read.js";
import { toolReadActivity } from "../src/activity/readActivity.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { PRIVACY_KEY } from "../src/privacy/engine.js";
import { ACTIVITY_PATH, renderFile } from "../../../packages/shared/src/activity.cjs";
import { FOLDER_ICONS_KEY, remapIcons, serializeFolderIcons } from "../../../packages/shared/src/folderIcons.cjs";

const WORKSPACE = "ws_fake_small_data";

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
    this.gets = [];
    this.puts = [];
  }
  seed(key, text) {
    this.objects.set(key, { text, etag: `e${++this.counter}` });
  }
  async get(key) {
    this.gets.push(key);
    const item = this.objects.get(key);
    if (!item) return null;
    return { key, etag: item.etag, size: item.text.length, text: async () => item.text };
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { key, etag: item.etag, size: item.text.length } : null;
  }
  async put(key, value) {
    this.puts.push(key);
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    this.objects.set(key, { text, etag: `e${++this.counter}` });
    return { key, etag: `e${this.counter}` };
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => ({ key, etag: item.etag, size: item.text.length }));
    return { objects, truncated: false };
  }
}

const RULES = `# Privacy

<!-- BEGIN BRAIN PRIVACY RULES -->

\`\`\`yaml
default_visibility: private

folder_defaults:
  1-projects/: team
  1-projects/vault/: private

note_overrides:
  # none
\`\`\`

<!-- END BRAIN PRIVACY RULES -->
`;

/** A store as a gateway with a control plane opens it, answering the ledger it is given. */
function heldStore(ledger, { withToken = true } = {}) {
  const store = new MemoryStore();
  store.seed(PRIVACY_KEY, RULES);
  store.seed("1-projects/plan.md", "# Plan\n");
  store.seed("1-projects/vault/codes.md", "# Codes\n");
  // What the bucket's file says is beside the point once the hooks are on: it
  // names the hidden destination, and must never be read.
  store.seed(
    FORWARDING_PATH,
    serializeForwarding({
      version: 1,
      entries: [{ from: "1-projects/was.md", to: "1-projects/vault/codes.md", kind: "note", at: 1 }],
    }),
  );
  store.seed(FOLDER_ICONS_KEY, serializeFolderIcons({ "1-projects/q3": "📦" }));
  const recorded = [];
  const asked = [];
  const controlPlane = {
    recordMoved: async (workspaceId, moved) => {
      recorded.push([workspaceId, moved]);
      return true;
    },
    reportTreeChange: async () => {},
    reportTreeTouch: async () => {},
    reportWebsiteChange: async () => {},
    reportRoutineChange: async () => {},
    reportContextMove: async () => {},
    reportSearchTiming: async () => {},
    reportActivity: async () => {},
  };
  if (withToken) {
    store.treeFacts = async (request) => {
      asked.push(request);
      return { served: true, forwarding: ledger };
    };
  }
  attachChangeReporters(store, WORKSPACE, controlPlane);
  return { store, recorded, asked };
}

test("with the hooks, neither file is read", async () => {
  const { store, recorded, asked } = heldStore([
    { from: "1-projects/old.md", to: "1-projects/plan.md", kind: "note", at: 5 },
  ]);
  assert.equal(Object.keys(store).includes("forwardingLedger"), false, "the hooks are not enumerable");
  const ledger = await readForwarding(store);
  assert.equal(forwardPath(ledger, "1-projects/old.md"), "1-projects/plan.md");
  assert.deepEqual(asked, [{ ask: "forwarding" }]);

  assert.equal(await recordForwarding(store, [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note" }, { from: "x.md", to: "x.md" }, { from: "../up.md", to: "1-projects/c.md" }], { now: 9 }), true);
  await remapIcons(store, [{ from: "1-projects/q3", to: "1-projects/q4" }]);
  assert.deepEqual(recorded, [
    [WORKSPACE, { forwarding: [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note" }] }],
    [WORKSPACE, { icons: [{ from: "1-projects/q3", to: "1-projects/q4" }] }],
  ]);
  assert.deepEqual(store.gets.filter((key) => key === FORWARDING_PATH || key === FOLDER_ICONS_KEY), []);
  assert.deepEqual(store.puts, []);
});

test("a store with no token to ask with reads an empty ledger, not the bucket's", async () => {
  const { store } = heldStore([], { withToken: false });
  const ledger = await readForwarding(store);
  assert.deepEqual(ledger.entries, []);
  assert.deepEqual(store.gets, []);
});

test("a trail into a hidden place is not found, exactly as a path that never existed", async () => {
  const { store } = heldStore([
    // As `/gateway/tree/facts` answers a team reader: the end it may not see is null.
    { from: "1-projects/was.md", to: null, kind: "note", at: 1 },
  ]);
  const { rules, overrides } = await loadPrivacyState(store);
  assert.equal(forwardPath(await readForwarding(store), "1-projects/was.md"), null);
  const trail = await toolReadNote(store, "team", rules, overrides, "1-projects/was.md");
  const never = await toolReadNote(store, "team", rules, overrides, "1-projects/never.md");
  assert.equal(JSON.stringify(trail).replace("was.md", "X"), JSON.stringify(never).replace("never.md", "X"));
  assert.ok(!JSON.stringify(trail).includes("vault"));
});

test("an activity line about a note moved out of sight is absent", async () => {
  const { store } = heldStore([{ from: "1-projects/was.md", to: null, kind: "note", at: 1 }]);
  const line = (at, paths) => ({ at, kind: "revised", paths, n: paths.length, vis: "team", by: "@kemi", via: "Claude", note: null });
  store.seed(
    ACTIVITY_PATH,
    renderFile([line("2026-10-14T11:00:00.000Z", ["1-projects/plan.md"]), line("2026-10-14T10:00:00.000Z", ["1-projects/was.md"])], ""),
  );
  const { rules, overrides } = await loadPrivacyState(store);
  const answer = JSON.stringify(await toolReadActivity(store, "team", rules, overrides, {}));
  assert.ok(answer.includes("plan.md"), answer);
  assert.ok(!answer.includes("was.md"), answer);
});

test("an answer is data: what is malformed is dropped", () => {
  const ledger = servedForwarding([
    { from: "1-projects/a.md", to: "1-projects/b.md", kind: "note", at: 1 },
    { from: "../escape.md", to: "1-projects/b.md", kind: "note", at: 1 },
    { from: "1-projects/c.md", to: "/../etc", kind: "note", at: 1 },
    { from: "1-projects/d.md", to: null, kind: "note" },
    { from: "1-projects/e.md", to: 7 },
    null,
  ]);
  assert.deepEqual(
    ledger.entries.map(({ from, to }) => [from, to]),
    [
      ["1-projects/a.md", "1-projects/b.md"],
      ["1-projects/d.md", null],
    ],
  );
  assert.deepEqual(servedForwarding("nope").entries, []);
});

test("moves are recorded in batches the touch route accepts", async () => {
  const posts = [];
  const tree = createTreeMethods({
    post: async (path, body) => {
      posts.push([path, body]);
      return {};
    },
  });
  const moves = Array.from({ length: SMALL_DATA_BATCH * 2 + 1 }, (_, i) => ({ from: `a/${i}.md`, to: `b/${i}.md`, kind: "note" }));
  await tree.recordMoved(WORKSPACE, { forwarding: moves, icons: [{ from: "a", to: "b" }] });
  assert.deepEqual(
    posts.map(([path, body]) => [path, body.workspaceId, (body.forwarding ?? body.icons).length]),
    [
      ["/gateway/tree/touch", WORKSPACE, SMALL_DATA_BATCH],
      ["/gateway/tree/touch", WORKSPACE, SMALL_DATA_BATCH],
      ["/gateway/tree/touch", WORKSPACE, 1],
      ["/gateway/tree/touch", WORKSPACE, 1],
    ],
  );
  assert.equal(await tree.recordMoved("", { forwarding: moves }), null);
});
