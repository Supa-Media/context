/**
 * The Lab's route summary (`features/tex/lab/engine/routeSummary.ts`): a run row's gold route is the set's label on that
 * message, and the words the "By route" block shows. Sabotage: read `labels.router` as `labels.route`, and the gold
 * reads null and these fail.
 */
import { describe, expect, test } from "@jest/globals";
import { goldRouteAt, perTurnWords, percentOf, routerWords, runRouteSummary, specialistWords } from "../features/tex/lab/engine/routeSummary";
import type { Conversation } from "../features/tex/lab/engine/sets";

const conv = {
  id: "trial-hire",
  title: "Trial hire",
  set: "training",
  kind: "one",
  members: [],
  msgs: [
    { id: "m0", who: "them", text: "Can you read my mail?", labels: { router: { route: "read", star: true } } },
    { id: "m1", who: "tex", text: "On it.", tex: true },
    { id: "m2", who: "them", text: "Thanks", labels: { decide: { run: "must not" } } },
  ],
} as unknown as Conversation;

describe("the gold route", () => {
  test("a message's labels.router.route, and null for a message, chat or label without one", () => {
    const gold = goldRouteAt([conv]);
    expect(gold("trial-hire", 0)).toBe("read");
    expect(gold("trial-hire", 1)).toBeNull();
    expect(gold("trial-hire", 2)).toBeNull();
    expect(gold("trial-hire", 9)).toBeNull();
    expect(gold("nobody", 0)).toBeNull();
  });
});

describe("a run's summary", () => {
  test("per route, router and specialist doors, from the run's rows and the set's gold", () => {
    const rows = [
      { convId: "trial-hire", msgIndex: 0, node: "fd", ok: true, usd: 0.02, route: { pick: "read", door: "read" } },
      { convId: "trial-hire", msgIndex: 0, node: "router", ok: false, route: { pick: "act", sure: 0.8 } },
      { convId: "trial-hire", msgIndex: 2, node: "fd", ok: true, usd: 0.01, route: { pick: "read", door: "fd", fellBack: "outside the read door's tools: send_email" } },
    ];
    const s = runRouteSummary(rows, [conv]);
    expect(s.any).toBe(true);
    expect(s.perRoute.find((b) => b.route === "read")).toMatchObject({ pass: 1, total: 1, usd: 0.02 });
    expect(s.perRoute.find((b) => b.route === "untagged")).toMatchObject({ pass: 1, total: 1, usd: 0.01 });
    // The router's own row only: the fd row's live pick counts in `fallback`, never as the router's.
    expect(s.router).toMatchObject({ right: 0, total: 1 });
    expect(s.router.confusion.read.read).toBe(0);
    expect(s.router.confusion.read.act).toBe(1);
    expect(s.fallback).toEqual({ fellBack: 1, specialist: 1, total: 2 });
    expect(s.costPerTurn).toEqual({ usd: 0.03, turns: 2, perTurn: 0.015 });
  });

  test("a run with no route data and no gold says nothing", () => {
    expect(runRouteSummary([{ convId: "trial-hire", msgIndex: 1, node: "fd", ok: true }], [conv]).any).toBe(false);
  });
});

describe("the words", () => {
  test("router, specialist doors, cost per turn and shares", () => {
    expect(routerWords({ right: 3, total: 5 })).toBe("Router: 3/5 right");
    expect(specialistWords({ specialist: 2, fellBack: 1, total: 3 })).toBe("Specialist doors: 2 of 3 turns, 1 fell back (33%)");
    expect(specialistWords({ specialist: 0, fellBack: 0, total: 0 })).toBe("Specialist doors: 0 of 0 turns, 0 fell back (0%)");
    expect(perTurnWords({ perTurn: 0.0123 })).toBe("Cost per turn $0.012");
    expect(percentOf(1, 4)).toBe("25%");
  });
});
