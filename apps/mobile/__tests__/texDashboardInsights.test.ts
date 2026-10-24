/**
 * What tex.lc/admin says (`features/tex/dashboard/insights.ts`): which
 * conversations count, how a shipped fix is judged, what a problem's status
 * is, and when a number may call itself better or worse.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-10-24):
 *
 *   `beforeAndSince` judging on every chat, not the problem's task  1
 *   `directionOf` ignoring `enough`                                 1
 *   `isCoded` counting rows from before codes began                 1
 */

import { describe, expect, test } from "@jest/globals";
import {
  CODES_BEGAN,
  beforeAndSince,
  directionOf,
  isSuccess,
  painStatusOf,
  untriagedSignals,
  type ThemeRow,
  type Tile,
  type TriageDesk,
} from "../features/tex/dashboard/insights";
import type { TexReview } from "../features/tex/dashboard/model";

const DAY = 86_400_000;
const SHIPPED = CODES_BEGAN + 10 * DAY;

function row(over: Partial<TexReview> = {}): TexReview {
  return {
    at: SHIPPED,
    kind: "one",
    reason: "ended",
    goal: 9,
    independence: 9,
    turns: 8,
    friendly: 8,
    calm: 9,
    task: "notes",
    signals: [],
    texts: 2,
    who: "other",
    costMicroUsd: 1_000,
    thought: false,
    ...over,
  };
}

function theme(over: Partial<ThemeRow> = {}): ThemeRow {
  return { path: "t.md", slug: "t", name: "Note saves", status: "shipped", signals: ["try_again"], tasks: ["notes"], prs: [2154], merged: SHIPPED, firstSeen: null, fixThread: null, ...over };
}

describe("what counts", () => {
  test("success is goal 8 or more without giving up", () => {
    expect(isSuccess(row())).toBe(true);
    expect(isSuccess(row({ goal: 7 }))).toBe(false);
    expect(isSuccess(row({ signals: ["gave_up"] }))).toBe(false);
  });

  test("signals with no named problem are listed, but only from coded rows in two weeks", () => {
    const now = SHIPPED + DAY;
    const desk = { themes: [theme()], bugs: [], reviews: [], available: true, slug: "x" } as TriageDesk;
    const rows = [row({ signals: ["try_again", "corrected"] }), row({ signals: ["corrected"] }), row({ at: CODES_BEGAN - DAY, signals: ["swore"] })];
    expect(untriagedSignals(desk, rows, now).map((signal) => [signal.code, signal.n])).toEqual([["corrected", 2]]);
  });
});

describe("a shipped fix", () => {
  test("is judged on the chats where it could have happened, before and since", () => {
    const before = [row({ at: SHIPPED - DAY, signals: ["try_again"] }), row({ at: SHIPPED - DAY, signals: ["try_again"] }), row({ at: SHIPPED - DAY })];
    const since = Array.from({ length: 5 }, () => row({ at: SHIPPED + DAY }));
    // Emails never count: the problem is about notes.
    const elsewhere = [row({ at: SHIPPED + DAY, task: "email", signals: ["try_again"] })];
    expect(beforeAndSince(theme(), [...before, ...since, ...elsewhere], SHIPPED + 2 * DAY)).toEqual({ before: { hits: 2, n: 3 }, since: { hits: 0, n: 5 }, verdict: "working" });
  });

  test("is too early with fewer than five chances since, and still happening when the rate holds", () => {
    const before = [row({ at: SHIPPED - DAY, signals: ["try_again"] }), row({ at: SHIPPED - DAY })];
    expect(beforeAndSince(theme(), [...before, row({ at: SHIPPED + DAY })], SHIPPED + 2 * DAY)?.verdict).toBe("too_early");
    const since = Array.from({ length: 6 }, (_, i) => row({ at: SHIPPED + DAY, signals: i < 3 ? ["try_again"] : [] }));
    expect(beforeAndSince(theme(), [...before, ...since], SHIPPED + 2 * DAY)?.verdict).toBe("still");
  });

  test("a problem's status reads the triage agent's words", () => {
    expect(painStatusOf(theme({ status: "Shipped" }))).toBe("shipped");
    expect(painStatusOf(theme({ status: "open", prs: [], fixThread: null }))).toBe("none");
    expect(painStatusOf(theme({ status: "open", prs: [], fixThread: "Fix it" }))).toBe("working");
    expect(painStatusOf(theme({ status: "retired" }))).toBe("retired");
    // The reviews folder's own words.
    expect(painStatusOf(theme({ status: "fixed" }))).toBe("shipped");
    expect(painStatusOf(theme({ status: "new", prs: [], fixThread: "none" }))).toBe("none");
    expect(painStatusOf(theme({ status: "triaged", prs: [], fixThread: null }))).toBe("working");
    expect(painStatusOf(theme({ status: "no action" }))).toBe("retired");
  });
});

describe("better or worse", () => {
  const tile = (over: Partial<Tile>): Tile => ({ key: "success", label: "x", value: 0.5, before: 0.7, target: 0.7, better: "up", unit: "pct", n: 30, beforeN: 30, enough: true, foot: "", ...over });

  test("needs enough in both windows to call it", () => {
    expect(directionOf(tile({}))).toBe("worse");
    expect(directionOf(tile({ enough: false }))).toBeNull();
    expect(directionOf(tile({ value: 0.71 }))).toBe("same");
    expect(directionOf(tile({ better: "down", unit: "seconds", value: 40_000, before: 80_000 }))).toBe("better");
  });
});
