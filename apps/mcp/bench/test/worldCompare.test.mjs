// One recorded world per compare (`worldCompare.mjs`): a snapshot both arms read, one memo of misses both share, a
// write-back once at the end, and each arm's misses counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { armDone, armMisses, finishCompare, memoDir, missGap, openCompare, snapshotPath, worldVerdict } from "../worldCompare.mjs";
import { fixturePath, fixtureText, nearestFixture, openWorldStore, readFixtures, worldKey } from "../simFixtures.mjs";
import { createSimWorld, simSystem } from "../simWorld.mjs";
import { installClock } from "../clock.mjs";

const ID = "lisbon-trip";

/** A tree with one Dev conversation and its saved fixtures (one search answer). */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "world-compare-"));
  mkdirSync(join(root, "apps/mcp/bench/sets/dev"), { recursive: true });
  writeFileSync(join(root, "apps/mcp/bench/sets/dev", `${ID}.json`), "{}\n");
  const request = { query: "weather in porto" };
  const answers = [{ key: worldKey("web search", request), kind: "web search", request, answer: { results: [{ title: "Porto", url: "https://weather.example/porto", description: "sunny" }] } }];
  mkdirSync(join(root, "apps/mcp/bench/sets/sim"), { recursive: true });
  writeFileSync(fixturePath(root, ID), fixtureText(ID, answers));
  return root;
}

/** A model that answers every world call with one search result naming how many calls it has had. */
function model() {
  const calls = [];
  const send = async (body) => {
    calls.push(JSON.parse(body));
    const text = JSON.stringify({ results: [{ title: `answer ${calls.length}`, url: "https://air.example", description: "$500" }] });
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: {} }), { status: 200 });
  };
  return { send, calls };
}

/** An arm's world for the compare's conversation: the snapshot's fixtures and the shared memo, as `storeFor` opens it. */
function armWorld(dir, arm, send) {
  const store = openWorldStore({ fixtures: readFixtures(snapshotPath(dir, ID)), runDir: memoDir(dir, ID), mode: "replay", test: "sets-1", arm });
  return createSimWorld({ send, store, today: "2026-03-04" });
}

test("the snapshot's hash is the same for both arms, however the fixtures change between them", () => {
  const root = tree();
  const dir = join(root, "compare");
  const base = openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  const before = readFileSync(snapshotPath(dir, ID), "utf8");
  writeFileSync(fixturePath(root, ID), fixtureText(ID, [])); // a heal lands mid-compare
  const draft = openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  assert.equal(draft.hash, base.hash);
  assert.match(base.hash, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(snapshotPath(dir, ID), "utf8"), before, "the draft reads the snapshot, not the changed file");
});

test("a miss is generated once and the other arm reuses it, for the same ask and a near one", async () => {
  const root = tree();
  const dir = join(root, "compare");
  openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  const { send, calls } = model();
  const fromBase = await armWorld(dir, "base", send).search("flights to lisbon");
  const fromDraft = await armWorld(dir, "draft", send).search("flights to lisbon");
  const nearDraft = await armWorld(dir, "draft", send).search("cheap flights to lisbon");
  assert.equal(calls.length, 1, "the world's model was asked once");
  assert.deepEqual(fromDraft, fromBase);
  assert.deepEqual(nearDraft, fromBase);
  // A snapshot answer is not a miss for either arm.
  await armWorld(dir, "draft", send).search("weather in porto");
  assert.equal(calls.length, 1);
  assert.equal(armMisses(dir, "base"), 1);
  assert.equal(armMisses(dir, "draft"), 1);
});

test("nothing is written back while the arms run, then once at finish, and never twice", async () => {
  const root = tree();
  const dir = join(root, "compare");
  const original = readFileSync(fixturePath(root, ID), "utf8");
  openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  const { send } = model();
  await armWorld(dir, "base", send).search("flights to lisbon");
  await armWorld(dir, "draft", send).search("hotels in lisbon");
  assert.equal(readFileSync(fixturePath(root, ID), "utf8"), original, "no write-back mid-compare");
  armDone(dir, "base");
  assert.throws(() => finishCompare(dir, { tree: root, log: () => {} }), /draft arm has not finished/);
  assert.equal(readFileSync(fixturePath(root, ID), "utf8"), original, "no write-back while an arm runs");
  armDone(dir, "draft");
  const first = finishCompare(dir, { tree: root, log: () => {} });
  assert.equal(first.wroteBack, true);
  const healed = readFixtures(fixturePath(root, ID));
  assert.equal(healed.size, 3, "the snapshot's answer and both misses");
  writeFileSync(fixturePath(root, ID), "sentinel");
  const second = finishCompare(dir, { tree: root, log: () => {} });
  assert.equal(second.wroteBack, false);
  assert.equal(readFileSync(fixturePath(root, ID), "utf8"), "sentinel", "a second finish writes nothing");
  assert.equal(second.line, "world misses: base 1, draft 1");
  assert.throws(() => openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] }), /finished/);
});

test("the snapshot is published as one folder, and a later open leaves nothing half-written behind", () => {
  const root = tree();
  const dir = join(root, "compare");
  const first = openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  const copy = readFileSync(snapshotPath(dir, ID), "utf8");
  assert.deepEqual(readdirSync(join(dir, "frozen")).sort(), [`${ID}.json`, "snapshot.json"]);
  writeFileSync(fixturePath(root, ID), fixtureText(ID, []));
  const late = openCompare(dir, { tree: root, convs: [{ id: ID, set: "dev" }] });
  assert.equal(late.hash, first.hash);
  assert.equal(readFileSync(snapshotPath(dir, ID), "utf8"), copy);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".frozen-")), [], "no snapshot left half-published");
});

test("world misses per arm, and a compare whose arms differ a lot is not the same recorded world", () => {
  assert.equal(missGap(18, 33), 9);
  assert.equal(missGap(1, 2), 5);
  const opus = worldVerdict(18, 33);
  assert.equal(opus.sameWorld, false);
  assert.match(opus.line, /^world misses: base 18, draft 33; not the same recorded world/);
  assert.match(opus.line, /no verdict/);
  assert.equal(worldVerdict(18, 22).sameWorld, true);
  assert.equal(worldVerdict(18, 22).line, "world misses: base 18, draft 22");
  assert.equal(worldVerdict(0, 4).sameWorld, true);
  assert.equal(worldVerdict(0, 5).sameWorld, false);
});

test("equally near fixtures tie-break on the key, whatever order they were added in", () => {
  const a = { key: worldKey("web search", { query: "lisbon flights may" }), kind: "web search", request: { query: "lisbon flights may" }, answer: "a" };
  const b = { key: worldKey("web search", { query: "lisbon flights june" }), kind: "web search", request: { query: "lisbon flights june" }, answer: "b" };
  const one = nearestFixture(new Map([[a.key, a], [b.key, b]]), "web search", { query: "lisbon flights" });
  const two = nearestFixture(new Map([[b.key, b], [a.key, a]]), "web search", { query: "lisbon flights" });
  assert.equal(one.key, two.key);
  assert.equal(one.key, [a.key, b.key].sort()[0]);
});

test("the world's prompt reads the test's scripted day, not the wall clock", async () => {
  const restore = installClock("2026-03-04", { stepped: true });
  try {
    assert.equal(new Date().toISOString().slice(0, 10), "2026-03-04");
    const { send, calls } = model();
    await createSimWorld({ send, today: "2026-03-04" }).search("anything");
    assert.match(calls[0].system, /Today is 2026-03-04\./);
  } finally {
    restore();
  }
  const real = new Date().toISOString().slice(0, 10);
  if (real !== "2026-03-04") assert.doesNotMatch(simSystem({ today: "2026-03-04" }), new RegExp(real));
});
