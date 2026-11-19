/**
 * The route summary (`packages/shared/src/texRouteSummary.cjs`): the Lab's "By route" block and tex_dev's `byRoute`
 * read it the same way. Sabotage: count ambiguous rows in perRoute, or read router rows as fd rows, and these fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { goldRouteAt, routeSummary } from "../../../packages/shared/src/texRouteSummary.cjs";

const GOLD = { "c:0": "quick", "c:1": "read", "c:2": "act", "c:3": "job", "c:4": "read" };
const goldOf = (convId, msgIndex) => GOLD[`${convId}:${msgIndex}`] ?? null;

const fd = (msgIndex, extra = {}) => ({ convId: "c", msgIndex, node: "fd", ok: true, usd: 0.01, ...extra });

test("per route: pass and cost of each gold route's fd rows that ran and are not ambiguous, and an untagged bucket", () => {
  const rows = [
    fd(0, { ok: true, usd: 0.02 }),
    fd(1, { ok: false, usd: 0.04 }),
    fd(4, { ok: true, usd: 0.01 }),
    fd(2, { ok: false, usd: 0.03, ambiguous: true }),
    fd(2, { ok: false, usd: 0.5, ran: false }),
    fd(9, { ok: true, usd: 0.06 }),
  ];
  const s = routeSummary(rows, goldOf);
  const by = Object.fromEntries(s.perRoute.map((b) => [b.route, b]));
  assert.deepEqual(by.quick, { route: "quick", pass: 1, total: 1, usd: 0.02, usdPerTurn: 0.02 });
  assert.deepEqual(by.read, { route: "read", pass: 1, total: 2, usd: 0.05, usdPerTurn: 0.025 });
  assert.deepEqual(by.act, { route: "act", pass: 0, total: 0, usd: 0, usdPerTurn: 0 }, "the ambiguous and the not-run rows are out");
  assert.deepEqual(by.job, { route: "job", pass: 0, total: 0, usd: 0, usdPerTurn: 0 });
  assert.deepEqual(by.untagged, { route: "untagged", pass: 1, total: 1, usd: 0.06, usdPerTurn: 0.06 });
});

test("router: confusion of gold against the pick, from the router's own rows and the fd rows that carry a pick", () => {
  const rows = [
    { convId: "c", msgIndex: 0, node: "router", ok: true, route: { pick: "quick", sure: 0.9 } },
    { convId: "c", msgIndex: 1, node: "router", ok: false, route: { pick: "act", sure: 0.7 } },
    { convId: "c", msgIndex: 4, node: "router", ok: true, route: { pick: "none", sure: 0.1 } },
    { convId: "c", msgIndex: 2, node: "router", ok: true, ran: false, route: { pick: "act" } },
    fd(1, { route: { pick: "read", door: "read" } }),
    fd(3, { ok: false, route: { pick: "job", door: "fd", fellBack: "x" } }),
    fd(2, { route: { door: "fd" } }),
    fd(0, { ambiguous: true, route: { pick: "read" } }),
    fd(9, { route: { pick: "quick" } }),
  ];
  const s = routeSummary(rows, goldOf);
  // Counted: the router's rows at c:0, c:1, c:4 (c:2 did not run); the fd rows at msg 1, 3 (msg 2 has no pick, msg 0
  // is ambiguous, msg 9 is untagged). Right: quick at c:0, read at msg 1, job at msg 3.
  assert.deepEqual(s.router, {
    right: 3,
    total: 5,
    confusion: {
      quick: { quick: 1, read: 0, act: 0, job: 0, none: 0 },
      read: { quick: 0, read: 1, act: 1, job: 0, none: 1 },
      act: { quick: 0, read: 0, act: 0, job: 0, none: 0 },
      job: { quick: 0, read: 0, act: 0, job: 1, none: 0 },
    },
  });
  assert.equal(s.router.confusion.read.none, 1, "a pick of none counts in its own column");
  assert.equal(s.router.confusion.read.act, 1, "the router's own row, picked act for a read");
});

test("fallback: how many turns a specialist ran behind, and how many handed over to the front door", () => {
  const rows = [
    fd(0, { route: { pick: "quick", door: "quick" } }),
    fd(1, { route: { pick: "read", door: "fd", fellBack: "outside the read door's tools: send_email" } }),
    fd(2, { route: { pick: "act", door: "act" } }),
    fd(3, {}),
    fd(4, { ambiguous: true, route: { pick: "read", door: "fd", fellBack: "y" } }),
  ];
  assert.deepEqual(routeSummary(rows, goldOf).fallback, { fellBack: 1, specialist: 2, total: 3 });
});

test("cost per turn: the fd rows' spend over the fd rows that ran; the router's own rows are not turns", () => {
  const rows = [fd(0, { usd: 0.01 }), fd(1, { usd: 0.02 }), fd(2, { usd: 0.5, ran: false }), { convId: "c", msgIndex: 0, node: "router", ok: true, usd: 0.3, route: { pick: "quick" } }];
  assert.deepEqual(routeSummary(rows, goldOf).costPerTurn, { usd: 0.03, turns: 2, perTurn: 0.015 });
});

test("any: true only when an fd row has a gold route or route data; an empty run has none", () => {
  assert.equal(routeSummary([fd(0)], goldOf).any, true, "a gold route on its message");
  assert.equal(routeSummary([fd(7, { route: { pick: "read" } })], goldOf).any, true, "route data");
  assert.equal(routeSummary([fd(7)], goldOf).any, false);
  assert.equal(routeSummary([{ convId: "c", msgIndex: 0, node: "decide", ok: true }], goldOf).any, false);
  const empty = routeSummary([], goldOf);
  assert.deepEqual([empty.router.total, empty.fallback.total, empty.costPerTurn], [0, 0, { usd: 0, turns: 0, perTurn: 0 }]);
  assert.equal(empty.perRoute.length, 5, "four gold routes and untagged, always shown");
});

test("the gold route of a message is its labels.router.route, a known route only, and null otherwise", () => {
  const gold = goldRouteAt([{ id: "c", msgs: [{ labels: { router: { route: "job", star: true } } }, { labels: { router: { route: "maybe" } } }, {}] }]);
  assert.equal(gold("c", 0), "job");
  assert.equal(gold("c", 1), null, "not a route");
  assert.equal(gold("c", 2), null, "no label");
  assert.equal(gold("c", 9), null, "no such message");
  assert.equal(gold("nobody", 0), null, "no such chat");
});
