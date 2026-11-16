/**
 * The test sets' one contract (`packages/shared/src/texSets.cjs`; Dev2, 2026-11-15): conversations, labels per
 * message × node, stars as unit tests, and the 60/20/20 ratio over stars.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   check() skips the Tex-row star rule          "a Tex row is never a unit test" fails
 *   check() accepts a `to` that comes later       "a special message points at an earlier one" fails
 *   labelFields() keeps optional fields           "labels use the node's required output fields" fails
 *   ratio() counts every label, not stars         "the ratio counts unit tests, never labels" fails
 *   DRIFT ignored in ratio()                      "a set may drift ten points, not more" fails
 *   check() skips the trigger's speaker rule      "a trigger row is the input that fired it" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import sets from "../../../packages/shared/src/texSets.cjs";
import decide from "../../../packages/shared/src/textDecide.cjs";

const config = JSON.parse(readFileSync(new URL("../../../packages/shared/src/texConfig.json", import.meta.url), "utf8"));
const why = Object.keys(decide.WHY);
const chat = (over = {}) => ({
  id: "ferry-trip", title: "Ferry trip planning", set: "dev", kind: "group", members: ["Rosa", "Kim"],
  msgs: [
    { id: "m1", who: "Rosa", text: "are we still doing the island on Saturday?" },
    { id: "m2", who: "Kim", text: "Tex can you check?", labels: { decide: { act: "respond", why: "asks_tex", star: true }, fd: { must: ["say 7:40"], star: true } } },
    { id: "m3", who: "Tex", tex: true, text: "First ferry is 7:40." },
    { id: "m4", who: "Rosa", kind: "react", to: "m3", text: "👍", labels: { decide: { act: "quiet", why: "thanks_or_ok" } } },
  ],
  ...over,
});

test("a sound conversation has no problems", () => {
  assert.deepEqual(sets.check(chat(), config, { why }), []);
});

test("a Tex row is never a unit test and carries no labels", () => {
  const c = chat(); c.msgs[2].star = true; c.msgs[2].labels = { decide: { act: "respond" } };
  const p = sets.check(c, config, { why });
  assert.ok(p.some((x) => x.includes("never a unit test")));
  assert.ok(p.some((x) => x.includes("labels go on people's messages")));
});

test("a special message points at an earlier one", () => {
  const c = chat(); c.msgs[3].to = "m9";
  assert.ok(sets.check(c, config, { why }).some((x) => x.includes("isn't earlier")));
  const d = chat(); d.msgs[1].to = "m1";
  assert.ok(sets.check(d, config, { why }).some((x) => x.includes("has no kind")));
});

test("labels use the node's required output fields, from the config", () => {
  const n = config.nodes.find((x) => x.id === "decide");
  const f = sets.labelFields(n, { why });
  assert.deepEqual(Object.keys(f.picks).sort(), ["act", "also_react", "moved_on", "why"]);
  assert.deepEqual(f.picks.act, ["quiet", "respond", "wait"]);
  assert.deepEqual(f.picks.why, why);
  assert.ok(f.texts.includes("emoji"));
  assert.equal(sets.labelFields(config.nodes.find((x) => x.id === "fd")).lines, true);
  const c = chat(); c.msgs[1].labels.decide.act = "shout"; c.msgs[1].labels.decide.mood = "x"; c.msgs[1].labels.triage = { must: ["x"] };
  const p = sets.check(c, config, { why });
  assert.ok(p.some((x) => x.includes('act "shout"')));
  assert.ok(p.some((x) => x.includes('"mood" is not one of its output fields')));
  assert.ok(p.some((x) => x.includes("lines are for the front door")));
  assert.ok(sets.check(chat({ msgs: [{ id: "m1", who: "Rosa", text: "hi", labels: { nope: {} } }] }), config).some((x) => x.includes('no node "nope"')));
});

test("members, ids and sets are checked", () => {
  const p = sets.check(chat({ id: "Bad Id", set: "held", members: ["Rosa", "Tex"] }), config, { why });
  assert.ok(p.some((x) => x.includes("lowercase")));
  assert.ok(p.some((x) => x.includes("set \"held\"")));
  assert.ok(p.some((x) => x.includes("never a member")));
  assert.ok(p.some((x) => x.includes("Kim is not in the chat's members")));
});

test("a unit test is one starred label: one message × one node", () => {
  assert.deepEqual(sets.unitTests(chat()), [
    { chat: "ferry-trip", msg: "m2", at: 1, node: "decide" },
    { chat: "ferry-trip", msg: "m2", at: 1, node: "fd" },
  ]);
  assert.deepEqual(sets.before(chat(), 1).map((m) => m.id), ["m1"]);
});

test("the ratio counts unit tests, never labels", () => {
  const r = sets.ratio([chat({ set: "training" }), chat({ set: "training" }), chat({ set: "training" }), chat({ set: "dev" })]);
  assert.deepEqual(r.counts, { training: 6, dev: 2, test: 0 });
  assert.equal(r.total, 8);
});

test("a set may drift ten points, not more", () => {
  assert.equal(sets.ratio({ training: 6, dev: 2, test: 2 }).holds, true);
  assert.equal(sets.ratio({ training: 8, dev: 2, test: 2 }).holds, true);
  const bad = sets.ratio({ training: 9, dev: 1, test: 0 });
  assert.equal(bad.holds, false);
  assert.deepEqual(bad.off, ["training", "test"]);
  assert.equal(sets.ratio({}).holds, false);
});

test("a trigger row is the input that fired it, never a member, and can be a unit test", () => {
  const c = chat({ kind: "one", members: ["Rosa"], msgs: [
    { id: "m1", who: "Check-in", via: "checkin", at: "Wed 9:20", text: "Gmail: the ferry company moved Saturday's first boat to 8:10", labels: { fd: { must: ["tell Rosa the new time"], star: true } } },
    { id: "m2", who: "Tex", tex: true, text: "Heads up, Saturday's first ferry is now 8:10." },
  ] });
  assert.deepEqual(sets.check(c, config), []);
  assert.equal(sets.unitTests(c).length, 1);
  const wrongWho = chat({ kind: "one", members: ["Rosa"], msgs: [{ id: "m1", who: "Rosa", via: "checkin", text: "x" }] });
  assert.match(sets.check(wrongWho, config).join("\n"), /fired by checkin, so its speaker is Check-in/);
  const unknown = chat({ kind: "one", members: ["Rosa"], msgs: [{ id: "m1", who: "Cron", via: "cron", text: "x" }] });
  assert.match(sets.check(unknown, config).join("\n"), /via "cron" must be one of checkin, routine, notify/);
});
