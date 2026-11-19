/**
 * The router's margin rule (`doorTools.js` `routeTrusted`, `specialistRoute.js` `readRoute`, `doorTurn.js`
 * `runWithDoors`, `production.js` `door_margin` / `door_floor`, `texConfig.js` `texSetupFront`, the config's `route`
 * field in `texConfigSchema.cjs`). With no rule the flat `ROUTE_AT` cutoff routes exactly as it always did.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *   `routeTrusted` ignoring `probs` (flat cutoff always)  -> the margin, tie and floor cases fail.
 *   a tie routed at margin 0 (`top - second < 0` check)     -> "exact tie never routes" fails.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { ROUTE_AT, routeOf, routeTrusted } from "../src/agent/doorTools.js";
import { readRoute, sureEnough } from "../src/agent/specialistRoute.js";
import { runWithDoors } from "../src/agent/doorTurn.js";
import { parseSetup } from "../src/agent/production.js";
import { TEX_CONFIG, texSetupFront } from "../src/agent/texConfig.js";

const require = createRequire(import.meta.url);
const { configProblems } = require("../../../packages/shared/src/texConfigSchema.cjs");

const spread = { quick: 0.1, read: 0.8, act: 0.05, job: 0.05 };
const tie = { quick: 0.4, read: 0.4, act: 0.1, job: 0.1 };

test("with no rule the flat cutoff routes: 0.6 does, 0.59 and a missing sure do not", () => {
  assert.equal(ROUTE_AT, 0.6);
  assert.equal(routeTrusted({ route: "read", sure: 0.6 }), true);
  assert.equal(routeTrusted({ route: "read", sure: 0.59 }), false);
  assert.equal(routeTrusted({ route: "read" }), false, "a missing sure is no route");
  assert.equal(routeTrusted({ route: "read", sure: 0.9 }, null), true);
  assert.equal(routeTrusted({ route: "read", sure: 0.6 }, { margin: NaN }), true, "a margin that is not a number is the old rule");
  assert.equal(routeTrusted(null), false);
  assert.equal(routeTrusted({ sure: 0.9 }), false, "no route is no route");
});

test("a margin rule routes a clear gap over the next class", () => {
  assert.equal(routeTrusted({ route: "read", probs: spread }, { margin: 0.15 }), true);
  assert.equal(routeTrusted({ route: "read", sure: 0.1, probs: spread }, { margin: 0.7 }), true, "a gap of exactly the margin routes");
});

test("an exact tie never routes, not even with margin 0", () => {
  assert.equal(routeTrusted({ route: "quick", sure: 0.9, probs: tie }, { margin: 0 }), false);
  assert.equal(routeTrusted({ route: "quick", sure: 0.9, probs: tie }, { margin: 0.15 }), false);
  assert.equal(routeTrusted({ route: "quick", sure: 0.9, probs: tie }), true, "no rule: the old cutoff, untouched");
});

test("a gap just below the margin does not route", () => {
  const read = { route: "read", probs: { read: 0.5, quick: 0.4, act: 0.05, job: 0.05 } };
  assert.equal(routeTrusted(read, { margin: 0.15 }), false);
  assert.equal(routeTrusted(read, { margin: 0.1 }), true);
});

test("a pick that is not the top class does not route", () => {
  assert.equal(routeTrusted({ route: "quick", probs: { read: 0.8, quick: 0.1, act: 0.05, job: 0.05 } }, { margin: 0 }), false);
});

test("missing probs, one class, or only non-finite values are no route under a margin rule", () => {
  const rule = { margin: 0 };
  assert.equal(routeTrusted({ route: "read", sure: 0.9 }, rule), false, "no probs: the front door");
  assert.equal(routeTrusted({ route: "read", probs: { read: 0.9 } }, rule), false, "one class is not a margin");
  assert.equal(routeTrusted({ route: "read", probs: { read: 0.9, quick: NaN, act: "0.1" } }, rule), false);
  assert.equal(routeTrusted({ route: "read", probs: { read: 0.9, quick: Infinity } }, rule), false, "infinite is not finite");
  assert.equal(routeTrusted({ route: "read", probs: [0.9, 0.1] }, rule), false, "probs must be an object");
  assert.equal(routeTrusted({ route: "read", probs: { read: 0.9, quick: 0.05, act: NaN } }, { margin: 0.5 }), true, "non-finite values are ignored");
});

test("a floor blocks a pick that is less likely than it", () => {
  const read = { route: "read", probs: { read: 0.45, quick: 0.3, act: 0.15, job: 0.1 } };
  assert.equal(routeTrusted(read, { margin: 0.1 }), true);
  assert.equal(routeTrusted(read, { margin: 0.1, floor: 0.4 }), true);
  assert.equal(routeTrusted(read, { margin: 0.1, floor: 0.5 }), false);
});

test("readRoute reads the probabilities, clamped, and null when they are absent", () => {
  assert.deepEqual(readRoute({ route: { choice: "read", confidence: 0.7, probabilities: { quick: 0.1, read: 0.7, act: 0.1, job: 0.1 } } }), {
    route: "read",
    sure: 0.7,
    probs: { quick: 0.1, read: 0.7, act: 0.1, job: 0.1 },
  });
  assert.deepEqual(readRoute({ route: { choice: "quick", confidence: 0.5, probabilities: { quick: 1.4, read: -0.2, job: "x" } } }).probs, { quick: 1, read: 0 });
  assert.equal(readRoute({ route: { choice: "quick", confidence: 0.5 } }).probs, null, "no probabilities");
  assert.equal(readRoute({ route: { choice: "quick", confidence: 0.5, probabilities: { quick: 0.9 } } }).probs, null, "one class is not enough");
  assert.equal(readRoute({ route: { choice: "quick", confidence: 0.5, probabilities: "0.9" } }).probs, null);
  assert.equal(sureEnough({ route: "quick", sure: 0.6 }), true);
  assert.equal(sureEnough({ route: "quick", sure: 0.59 }), false);
});

test("routeOf carries the probabilities, finite and clamped, and only when given", () => {
  const now = () => 5;
  assert.deepEqual(routeOf({ route: "read", sure: 0.7, probs: { read: 0.7, quick: 0.3, act: NaN } }, 0, now), { route: "read", sure: 0.7, ms: 5, probs: { read: 0.7, quick: 0.3 } });
  assert.equal("probs" in routeOf({ route: "read", sure: 0.7 }, 0, now), false);
  assert.equal(routeOf({ route: "read", sure: 2, probs: { read: 2 } }, 0, now).probs.read, 1);
});

test("runWithDoors under a margin rule: a tie runs the front door only, a clear gap runs the door", async () => {
  const calls = [];
  const doors = [];
  const runTurn = async (options) => (calls.push(options), { answer: "ok" });
  const via = { door: async (route) => (doors.push(route), { door: route }) };
  const tied = { route: "quick", sure: 0.9, probs: tie, ms: 1 };
  const frontOnly = await runWithDoors({ runTurn, args: { question: "q" }, eligible: true, route: tied, via, routeRule: { margin: 0.15 } });
  assert.equal(frontOnly.route.door, "fd");
  assert.deepEqual(doors, [], "the door is never asked for a tie");
  assert.equal(calls.length, 1, "one front door run");

  const gap = { route: "read", sure: 0.9, probs: spread, ms: 1 };
  const specialist = await runWithDoors({ runTurn, args: { question: "q" }, eligible: true, route: gap, via, routeRule: { margin: 0.15 } });
  assert.deepEqual(doors, ["read"]);
  assert.equal(specialist.route.door, "read");

  // No rule: the flat cutoff routes the tie, as before.
  doors.length = 0;
  const flat = await runWithDoors({ runTurn, args: { question: "q" }, eligible: true, route: { ...tied, route: "quick" }, via });
  assert.equal(flat.route.door, "quick");
  assert.deepEqual(doors, ["quick"]);
});

test("production reads door_margin and door_floor, refuses a bad value, and a floor with no margin", async () => {
  const front = "models:\n  main: anthropic/claude-haiku-5-5";
  const file = (lines) => `---\n${front}\n${lines}\n---\n\nAnswer briefly.\n`;
  assert.equal((await parseSetup(file("")))?.doorRoute, null, "absent: the 0.6 cutoff");
  assert.deepEqual((await parseSetup(file("  door_margin: 0.15")))?.doorRoute, { margin: 0.15 });
  assert.deepEqual((await parseSetup(file("  door_margin: 0.15\n  door_floor: 0.4")))?.doorRoute, { margin: 0.15, floor: 0.4 });
  assert.equal(await parseSetup(file("  door_margin: 1.5")), null);
  assert.equal(await parseSetup(file("  door_margin: 0.15\n  door_floor: 1.5")), null);
  assert.equal(await parseSetup(file("  door_floor: 0.4")), null, "a floor with no margin");
});

test("texSetupFront writes the router's door rule as models lines, and a config with no rule writes none", () => {
  const config = structuredClone(TEX_CONFIG);
  config.nodes.find((node) => node.id === "router").route = { margin: 0.15, floor: 0.4 };
  const models = texSetupFront(config).models;
  assert.equal(models.door_margin, "0.15");
  assert.equal(models.door_floor, "0.4");
  assert.equal(texSetupFront(TEX_CONFIG).models.door_margin, "0.3", "main's margin, tuned on held-out Training");
  const none = structuredClone(TEX_CONFIG);
  delete none.nodes.find((node) => node.id === "router").route;
  assert.equal(texSetupFront(none).models.door_margin, undefined);
  const margin = structuredClone(TEX_CONFIG);
  margin.nodes.find((node) => node.id === "router").route = { margin: 0.2 };
  assert.equal(texSetupFront(margin).models.door_floor, undefined);
});

test("the config schema accepts a router route of margin and floor, and refuses anything else", () => {
  const base = TEX_CONFIG;
  const withRoute = (route) => {
    const config = structuredClone(base);
    config.nodes.find((node) => node.id === "router").route = route;
    return configProblems(config).filter((problem) => problem.includes('"router"'));
  };
  assert.deepEqual(withRoute({ margin: 0.2, floor: 0.5 }), []);
  assert.equal(withRoute({ margin: 1.5 }).length, 1);
  assert.equal(withRoute({ other: 1 }).length, 1);
  assert.equal(withRoute(["margin"]).length, 1);
});
