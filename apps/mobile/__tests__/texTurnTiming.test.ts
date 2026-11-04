/**
 * @jest-environment jsdom
 */

/**
 * Where one Tex turn's time went, in the chat's history, for staff only (Dev,
 * 2026-11-03: "I need to be able to look at an interaction with Tex and tell
 * exactly why things might be slow", then "only breakdowns for developers").
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-03):
 *  1. `TexHistoryLines` asking for the timing whoever is viewing → "anyone
 *     else sees the history as it was" fails.
 *  2. `historyDays` drawing `reply` entries as lines → "a reply is never a
 *     line" fails.
 *  3. The pill measured from the gateway's start, not the text's arrival →
 *     "the pill is the wait" fails.
 *  4. `slowest` marking the first row instead of the longest → "the slowest
 *     step is named" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { historyDays, kindsFor, DEFAULT_SHOWN } from "../features/tex/history/historyLines";
import { modelName, seconds, turnTimingView } from "../features/tex/history/turnTiming";
import type { LedgerEntry, LedgerQuery } from "../features/tex/page/texPageTypes";
import type { TexPageSource } from "../features/tex/page/texPageSource";

let mockStaff = false;
jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => mockStaff }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { TexHistoryLines } from "../features/tex/history/TexHistoryLines";

// The 10:47 AM turn of 2026-11-03, as its reply now keeps it (setup split made up): every `at` from the gateway reading the text.
const ARRIVED = new Date(2026, 10, 3, 10, 47, 2).getTime();
const GATEWAY = ARRIVED + 1_200;
const NOW = new Date(2026, 10, 3, 18, 0);
const timing = {
  v: 1,
  waitMs: 1_200,
  replyMs: 20_007,
  steps: [
    { name: "read_request", at: 2, ms: 100 },
    { name: "wait:history", at: 110, ms: 1_600 },
    { name: "web_setup", at: 1_720, ms: 900 },
    { name: "waiting_asks", at: 2_630, ms: 600, state: "off" },
    { name: "pictures_setup", at: 3_240, ms: 300 },
    { name: "model", at: 3_800, ms: 16_100 },
    { name: "usage_record", at: 19_910, ms: 90 },
  ],
  rounds: [
    { at: 3_800, ms: 9_000, model: "anthropic/claude-haiku-5-5", input: 3_900, output: 620, cacheRead: 41_000, cacheWrite: 0, said: 0, calls: 1 },
    { at: 13_600, ms: 1_800, model: "anthropic/claude-haiku-5-5", input: 4_700, output: 85, cacheRead: 44_900, cacheWrite: 0, said: 0, calls: 1 },
    { at: 16_800, ms: 2_900, model: "anthropic/claude-haiku-5-5", input: 5_600, output: 140, cacheRead: 45_200, cacheWrite: 0, said: 96, calls: 0 },
  ],
  tools: [
    { at: 12_800, ms: 800, name: "search_notes" },
    { at: 15_400, ms: 1_400, name: "search_notes" },
  ],
};
const entries: LedgerEntry[] = [
  { id: "e7", at: GATEWAY + 20_007 + 1_100, kind: "text", turn: "t1", from: { kind: "tex" }, event: "link", text: "https://context.lc/note/@seyi/inbox/Grocery%20List.md" },
  { id: "e6", at: GATEWAY + 20_007 + 600, kind: "text", turn: "t1", from: { kind: "tex" }, text: "Here's the note with the ice cream on it, the grocery list:" },
  { id: "e5", at: GATEWAY + 20_007, kind: "reply", turn: "t1", ms: 20_007, text: "Here's the note…", timing },
  { id: "e4", at: GATEWAY + 15_000, kind: "tool", turn: "t1", name: "search_notes", args: { query: "Grocery List ice cream cookies and cream" }, ok: true, ms: 1_400 },
  { id: "e3", at: GATEWAY + 13_000, kind: "tool", turn: "t1", name: "search_notes", args: { query: "ice cream note" }, ok: true, ms: 800 },
  { id: "e1", at: ARRIVED, kind: "text", from: { kind: "person" }, text: "can you text me a link and not a note card" },
];

describe("a turn's timing, worked out", () => {
  test("the pill is the wait: from the text arriving to the first bubble out, amber past ten seconds", () => {
    const view = turnTimingView({ reply: entries[2]!, sent: [entries[1]!, entries[0]!], tools: [entries[4]!, entries[3]!] })!;
    expect(seconds(view.totalMs)).toBe("21.8 s");
    expect(view.slow).toBe(true);
  });

  test("the slowest step is named, and is the only solid bar", () => {
    const view = turnTimingView({ reply: entries[2]!, sent: [entries[1]!, entries[0]!], tools: [entries[4]!, entries[3]!] })!;
    expect(view.verdict.strong).toBe("the first model call: 9.0 s");
    expect(view.verdict.rest).toBe(" of 21.8 s, most of it thinking (~580 tokens).");
    expect(view.rows.flatMap((r) => r.children ?? [r]).filter((r) => r.slowest).map((r) => r.key)).toEqual(["round:0"]);
    expect(view.split.split(" · ")[0]).toBe("Model 13.7 s");
  });

  test("the rows run in order on one clock: the line, getting ready, the model and tools as they ran, then the sends", () => {
    const view = turnTimingView({ reply: entries[2]!, sent: [entries[1]!, entries[0]!], tools: [entries[4]!, entries[3]!] })!;
    expect(view.rows.map((r) => r.label)).toEqual([
      "Waiting in line",
      "Getting ready",
      "Model, round 1",
      "search_notes “ice cream note”",
      "Model, round 2",
      "search_notes “Grocery List ice cream cookies and cream”",
      "Model, round 3",
      "Recording usage",
      "First text out",
      "Next text out",
    ]);
    const setup = view.rows[1]!;
    expect(setup.ms).toBe(3_800);
    expect(setup.children!.map((c) => c.code)).toEqual(["read_request", "wait:history", "web_setup", "waiting_asks", "pictures_setup"]);
    expect(view.rows[2]!.start).toBe(1_200 + 3_800);
    expect(view.rows[2]!.detail).toBe("3,900 in · 41,000 cached · 620 out · said nothing, called 1 tool → ~580 thinking");
    expect(view.rows.at(-1)!.after).toBe(true);
    expect(modelName("anthropic/claude-haiku-5-5")).toBe("Haiku 5.5");
  });

  test("a reply that kept no timing has no view, and a reply is never a line", () => {
    const old = { ...entries[2]!, timing: undefined };
    expect(turnTimingView({ reply: old, sent: [], tools: [] })).toBeNull();
    const lines = historyDays(entries, NOW, { timing: true }).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.some((l) => l.entry.kind === "reply")).toBe(false);
    expect(lines.filter((l) => l.timing !== undefined).map((l) => l.id)).toEqual(["e6"]);
    expect(historyDays(entries, NOW).flatMap((d) => d.turns.flatMap((t) => t.lines)).some((l) => l.timing !== undefined)).toBe(false);
  });

  test("staff read each turn's reply (and its calls, even with Tool calls off); nobody else does", () => {
    expect(kindsFor(DEFAULT_SHOWN)).not.toContain("reply");
    expect(kindsFor(DEFAULT_SHOWN, { timing: true })).toContain("reply");
    expect(kindsFor({ ...DEFAULT_SHOWN, tools: false }, { timing: true })).toEqual(expect.arrayContaining(["reply", "tool"]));
    const hidden = historyDays(entries, NOW, { timing: true, tools: false }).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(hidden.some((l) => l.entry.kind === "tool")).toBe(false);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const asked: LedgerQuery[] = [];
const source = {
  ledger: async (_chat: string, query: LedgerQuery) => {
    asked.push(query);
    return { kind: "ok", value: { manifest: { schema: "tex-ledger", version: 1, count: entries.length, created: null, updated: null }, entries: entries.filter((e) => query.kinds?.includes(e.kind as never)) } };
  },
  live: () => null,
} as unknown as TexPageSource;
beforeEach(() => {
  asked.length = 0;
  jest.useFakeTimers({ now: NOW, doNotFake: ["setTimeout", "queueMicrotask", "nextTick", "setImmediate"] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("the timing in the history", () => {
  test("staff see the wait on the turn's first text, and it opens to where the time went", async () => {
    mockStaff = true;
    act(() => root.render(createElement(TexHistoryLines, { source, chat: "me", group: false })));
    await settle();
    expect(asked[0]!.kinds).toContain("reply");
    const pill = byTest("tex-history-timing-pill-e6")!;
    expect(pill.textContent).toBe("21.8 s");
    act(() => pill.click());
    const panel = byTest("tex-history-timing-e6")!;
    expect(panel.textContent).toContain("The biggest part of this wait was");
    expect(panel.textContent).toContain("the first model call: 9.0 s");
    expect(byTest("tex-history-timing-row-round:0")).not.toBeNull();
    act(() => byTest("tex-history-timing-raw-e6")!.click());
    expect(panel.textContent).toContain('"replyMs": 20007');
  });

  test("anyone else sees the history as it was: no pill, and no reply asked for", async () => {
    mockStaff = false;
    act(() => root.render(createElement(TexHistoryLines, { source, chat: "me", group: false })));
    await settle();
    expect(asked[0]!.kinds).not.toContain("reply");
    expect(container.querySelector('[data-testid^="tex-history-timing"]')).toBeNull();
    expect(container.textContent).toContain("Here's the note with the ice cream on it");
  });
});
