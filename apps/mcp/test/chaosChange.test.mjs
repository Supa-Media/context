/**
 * WHAT ONE CHANGE DID TO THE CHAOS SCORE, COUNTED FROM THE CONVEX TREE.
 *
 * `chaos/change.js` replaces the search database's per-folder table (retired
 * in phase 7) for the owner's per-write report: `write_note`, `move_note`,
 * `move_notes`, `move_folder` and `archive_note` answer with the score before
 * and after and the folders touched. What is asked:
 *
 *  1. A created note, a moved note and a moved folder each report the totals
 *     the keys give before and after, and the folders the change touched.
 *  2. Applying the change is idempotent: a tree that already heard of it
 *     reports no change rather than counting it twice.
 *  3. A note the change wrote is read again for its length.
 *  4. No tree, no facts, no answer: `null`, never a guess, never a throw.
 *  5. A team reader is never named a folder the team cannot open.
 *  6. `recordChange` counts before it tells the control plane, so the keys
 *     it counts from are the keys before the change.
 *
 * Sabotage-checked: counting the after from the keys unchanged fails 1;
 * adding a written note that is already there again fails 2; dropping the
 * re-read fails 3; naming every folder whatever `team_exists` says fails 5;
 * telling the control plane before counting fails 6.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { R2Store } from "../src/store/r2.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { canSee } from "../src/privacy/engine.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { changeChaos, keysAfterChange } from "../src/chaos/change.js";
import { liveTotals, scoreKeys } from "../src/chaos/live.js";
import { chaosLines, takeChaos } from "../src/chaos/report.js";
import { recordChange } from "../src/activity/record.js";

/**
 * The access rows the control plane serves beside the binding: `1-projects/` is the team's, everything else
 * private. The gateway judges by these, never by a `privacy.md` in the bucket.
 */
const ROWS = {
  etag: "rows-1",
  accessVersion: 1,
  folders: [{ prefix: "1-projects", visibility: "team" }],
  notes: [],
};

const words = "plan budget people risks notes ideas launch review hiring roadmap legal design press travel".split(" ");

function workspaceKeys() {
  return [
    "index.md",
    ...words.map((word) => `1-projects/big/${word}.md`),
    ...words.slice(0, 4).map((word) => `1-projects/small/${word}.md`),
    "2-areas/private/secret-plan.md",
    "2-areas/private/secret-budget.md",
    "2-areas/private/deep/one.md",
    "2-areas/health.md",
  ];
}

/**
 * A session store over a bucket, with the Convex tree serving `keys` and its
 * facts answering `extras`. The access rows are `rules` (`ROWS` by default,
 * `null` for a session the control plane has sent no rules to), wrapped the
 * way the real session wraps its store. The bucket holds any `texts`.
 */
async function servedStore({ keys = workspaceKeys(), extras = [], texts = {}, served = true, facts = true, rules = ROWS } = {}) {
  const raw = memoryBucket();
  for (const [path, text] of Object.entries(texts)) await raw.put(path, text);
  const bare = new R2Store(raw);
  const store = Object.create(rules ? withPrivacyAuthority(bare, { rules }) : bare);
  const asked = [];
  Object.defineProperty(store, "treeManifest", {
    value: async () => {
      asked.push("manifest");
      return served ? { served: true, entries: keys.map((path) => ({ path })), cursor: null } : { served: false };
    },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(store, "treeFacts", {
    value: async (request) => {
      asked.push(request.ask);
      return facts ? { served: true, chaos: { extras, weekAgo: null } } : { served: false };
    },
    enumerable: false,
    configurable: true,
  });
  store.asked = asked;
  return store;
}

async function expectedTotals(store, keys, extras = new Map()) {
  const state = await loadPrivacyState(store);
  return liveTotals(scoreKeys(keys, extras, (path) => canSee(path, "team", state.rules, state.overrides)));
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const entryOf = (report, folder) => report.folders.find((entry) => entry.folder === folder);

test("1a. a created note: the totals before and after, and its folder one item fuller", async () => {
  const store = await servedStore();
  const report = await changeChaos(store, { paths: ["1-projects/big/extra.md"] });
  const before = await expectedTotals(store, workspaceKeys());
  const after = await expectedTotals(store, [...workspaceKeys(), "1-projects/big/extra.md"]);
  assert.ok(near(report.before.all, before.all) && near(report.before.team, before.team));
  assert.ok(near(report.after.all, after.all) && near(report.after.team, after.team));
  assert.ok(report.after.all > report.before.all, "a 15th note in a crowded folder makes things worse");
  const big = entryOf(report, "1-projects/big");
  assert.equal(big.before.items, 14);
  assert.equal(big.after.items, 15);
  assert.equal(big.after.team_exists, 1);
  assert.deepEqual(Object.keys(big.after).sort(), ["folder", "items", "sum", "team_exists", "team_items", "team_sum", "team_weight", "weight"]);
  assert.match(chaosLines(report, "all"), /1-projects\/big: 14 → 15 items/);
});

test("1b. a moved note leaves one folder and fills another", async () => {
  const store = await servedStore();
  const from = "1-projects/big/press.md";
  const to = "1-projects/small/press.md";
  const report = await changeChaos(store, { paths: [from, to], moves: [[from, to]] });
  const moved = workspaceKeys().map((key) => (key === from ? to : key));
  const after = await expectedTotals(store, moved);
  assert.ok(near(report.after.all, after.all));
  assert.ok(report.after.all < report.before.all, "a note from a crowded folder into a thin one calms things");
  assert.equal(entryOf(report, "1-projects/big").after.items, 13);
  assert.equal(entryOf(report, "1-projects/small").before.items, 4);
  assert.equal(entryOf(report, "1-projects/small").after.items, 5);
});

test("1c. a moved folder: gone from where it was, scored where it went, and both parents told", async () => {
  const store = await servedStore();
  const report = await changeChaos(store, {
    paths: ["1-projects/small", "1-projects/big/small"],
    moves: [["1-projects/small", "1-projects/big/small"]],
  });
  const moved = workspaceKeys().map((key) => key.replace(/^1-projects\/small\//, "1-projects/big/small/"));
  assert.ok(near(report.after.all, (await expectedTotals(store, moved)).all));
  const old = entryOf(report, "1-projects/small");
  assert.ok(old.before !== null && old.after === null);
  const now = entryOf(report, "1-projects/big/small");
  assert.ok(now.before === null && now.after.items === 4);
  assert.equal(entryOf(report, "1-projects/big").after.items, 15, "the moved folder is one more item in big");
  assert.equal(entryOf(report, "1-projects").after.items, 1, "and one fewer in projects");
  const text = chaosLines(report, "all");
  assert.match(text, /1-projects\/small: gone/);
});

test("2. a change the tree already shows is not counted twice", async () => {
  const from = "1-projects/big/press.md";
  const to = "1-projects/small/press.md";
  const already = workspaceKeys().map((key) => (key === from ? to : key));
  const store = await servedStore({ keys: already });
  const report = await changeChaos(store, { paths: [from, to], moves: [[from, to]] });
  assert.ok(near(report.before.all, report.after.all));
  assert.deepEqual(keysAfterChange(already, { moves: [[from, to]] }).sort(), [...already].sort());
  const created = await changeChaos(await servedStore(), { files: ["1-projects/big/plan.md"] });
  assert.ok(near(created.before.all, created.after.all), "a note that is already there is not added again");
});

test("3. a note the change wrote is read again for its length", async () => {
  const path = "1-projects/small/plan.md";
  const store = await servedStore({ texts: { [path]: "line\n".repeat(2500) } });
  const report = await changeChaos(store, { files: [path] });
  assert.ok(report.after.all > report.before.all, "a note past 2,000 lines adds chaos at once");
  // A meeting is exempt, however long.
  const meeting = await servedStore({ texts: { [path]: `---\ntype: meeting\n---\n${"said\n".repeat(3000)}` } });
  const exempt = await changeChaos(meeting, { files: [path] });
  assert.ok(near(exempt.after.all, exempt.before.all));
  // A long note moved keeps its length where it went.
  const extras = [{ path: "1-projects/big/novel.md", lines: 2500, exempt: false, review: false }];
  const moving = await servedStore({ keys: [...workspaceKeys(), "1-projects/big/novel.md"], extras });
  const moved = await changeChaos(moving, {
    paths: ["1-projects/big/novel.md", "2-areas/novel.md"],
    moves: [["1-projects/big/novel.md", "2-areas/novel.md"]],
  });
  const state = await loadPrivacyState(moving);
  const team = (key) => canSee(key, "team", state.rules, state.overrides);
  const keysAfter = keysAfterChange([...workspaceKeys(), "1-projects/big/novel.md"], { moves: [["1-projects/big/novel.md", "2-areas/novel.md"]] });
  const expected = liveTotals(scoreKeys(keysAfter, new Map([["2-areas/novel.md", { lines: 2500, exempt: false, review: false }]]), team));
  assert.ok(near(moved.after.all, expected.all));
});

test("4. no tree, no facts, no answer, and never a throw", async () => {
  assert.equal(await changeChaos(await servedStore(), null), null);
  assert.equal(await changeChaos(await servedStore({ served: false }), { files: ["1-projects/a.md"] }), null);
  assert.equal(await changeChaos(await servedStore({ facts: false }), { files: ["1-projects/a.md"] }), null);
  const raw = memoryBucket();
  assert.equal(await changeChaos(new R2Store(raw), { files: ["1-projects/a.md"] }), null, "a self-hosted gateway with no control plane");
  const broken = await servedStore();
  Object.defineProperty(broken, "treeFacts", { value: async () => { throw new Error("down"); } });
  assert.equal(await changeChaos(broken, { files: ["1-projects/a.md"] }), null);
  // A session the control plane has sent no access rows to judges nothing: the score is not guessed.
  assert.equal(await changeChaos(await servedStore({ rules: null }), { files: ["1-projects/a.md"] }), null);
});

test("5. a team reader is never named a folder the team cannot open", async () => {
  const store = await servedStore();
  // A private folder gains a note and a subfolder appears inside it.
  const report = await changeChaos(store, { paths: ["2-areas/private/deep/two.md", "2-areas/private/fresh/new.md"] });
  const named = report.folders.map((entry) => entry.folder);
  assert.ok(named.includes("2-areas/private/fresh"), "the owner is told");
  assert.ok(named.includes("2-areas/private"));
  const team = chaosLines(report, "team");
  assert.doesNotMatch(team, /private|2-areas/, team);
  assert.ok(near(report.before.team, report.after.team), "the team's score does not move for what it cannot see");
  assert.match(chaosLines(report, "all"), /2-areas\/private/);
});

test("6. recordChange counts from the keys before it tells the control plane", async () => {
  const store = await servedStore();
  const order = [];
  const manifest = store.treeManifest;
  Object.defineProperty(store, "treeManifest", {
    // Recorded once the keys have arrived, a moment late, as a real request would.
    value: async (...args) => {
      const answer = await manifest(...args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("keys");
      return answer;
    },
  });
  store.reportTreeTouch = async (touch) => {
    order.push(`touch ${touch.paths.join(",")}`);
  };
  const deferred = [];
  store.defer = (work) => deferred.push(work);
  await store.put("1-projects/big/extra.md", "# extra");
  await recordChange(store, "create_note", "private", ["1-projects/big/extra.md"], {});
  const report = await takeChaos(store);
  await Promise.all(deferred);
  assert.equal(entryOf(report, "1-projects/big").after.items, 15);
  assert.deepEqual(order.filter((step) => step === "keys" || step.startsWith("touch")), ["keys", "touch 1-projects/big/extra.md"]);

  // A change no tool reports on is not counted at all.
  const quiet = await servedStore();
  quiet.reportTreeTouch = async () => {};
  await recordChange(quiet, "save_context", "private", ["0-inbox/context.md"], {});
  assert.equal(takeChaos(quiet), undefined);
  assert.ok(!quiet.asked.includes("chaos"));
});
