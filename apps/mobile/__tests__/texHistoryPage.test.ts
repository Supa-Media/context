/**
 * @jest-environment jsdom
 */

/**
 * The chat's history file on the Tex page (decided by the owner, 2026-11-02:
 * one history file, one line a message, and a view of exactly what Tex
 * sees): reached from Behind the scenes, filtered by day and by what is shown
 * through the gateway, each line opening to its entry as kept, and "What Tex
 * sees" with the settings that shaped it.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-02):
 *  1. The shown kinds not sent to the gateway → "the day and what is shown
 *     are asked of the gateway" fails.
 *  2. A half-typed day sent as typed → same test fails.
 *  3. `gatewaySource.sees` posting `view: "raw"` → "the source posts the
 *     ledger route" fails.
 *  4. The page's "Show more" not checking the filter it was asked under →
 *     "Show older reads on … dropped" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { fixtureNow, fixtureSource } from "../features/tex/page/texPageFixture";
import { entryLine, readLedgerPage, readLedgerSees } from "../features/tex/page/texPageLedger";
import { gatewaySource, type TexPageSource } from "../features/tex/page/texPageSource";
import { LATEST, type LedgerEntry, type LedgerQuery } from "../features/tex/page/texPageTypes";
import { useTexPage } from "../features/tex/page/useTexPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ source, start }: { source: TexPageSource; start: Place }) {
  const [place, setPlace] = useState<Place>(start);
  const page = useTexPage(source, place.chat);
  return createElement(TexPageBody, { source, page, place, go: setPlace, computer: null, openComputer: () => {}, now: fixtureNow });
}

const tick = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function render(source: TexPageSource, start: Place = { chat: "me" }) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source, start }))));
  await tick();
}

const text = () => container.textContent ?? "";
// A select's list opens over the whole page (TexSelect), outside the page's own element.
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const el = byTestId(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
  await tick();
}
async function type(id: string, value: string) {
  const input = byTestId(id) as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick();
}

const SHOWN_KINDS = ["text", "tool", "judge", "note", "advisor", "mail_check", "job"];

describe("the chat's history file", () => {
  test("is one tap from the hub's history, one line a message, the turn in the order it happened", async () => {
    await render(fixtureSource());
    await press("tex-history-open-full");
    expect(byTestId("tex-history")).not.toBeNull();
    expect(byTestId("tex-history-day-2026-11-02")?.textContent).toContain("Today");
    const line = (id: string) => byTestId(`tex-history-entry-${id}`)?.textContent ?? "";
    expect(line("me-e1")).toBe("9:02 AMYouwhat's on my calendar today?");
    // The turn's two calls are one line, opened on a tap.
    expect(line("calls:me-e3")).toBe("▸ 2 tool calls · calendar_events, read_note");
    expect(byTestId("tex-history-entry-me-e3")).toBeNull();
    await press("tex-history-entry-calls:me-e3");
    expect(line("me-e3")).toBe("calendar_events");
    expect(line("me-e4")).toBe("read_note · result withheld (another workspace)");
    expect(line("me-e6")).toBe("9:03 AMTexStandup at 10 and the dentist at 3.");
    // Tex's answer is said once: its text, not the gateway's copy of it as well.
    expect(text().split("Standup at 10").length - 1).toBe(1);
    // Thinking is off until asked for.
    expect(text()).not.toContain("Look at today's calendar");
    expect(text().indexOf("what's on my calendar today?")).toBeLessThan(text().indexOf("Standup at 10"));
    await press("tex-history-entry-me-e3");
    const raw = byTestId("tex-history-raw-me-e3")?.textContent ?? "";
    expect(JSON.parse(raw)).toMatchObject({ kind: "tool", name: "calendar_events", args: { day: "today" } });
  });

  test("reads as the history file does: live, the filters above its own scroller, newest at the bottom", async () => {
    // Dev, 2026-11-05: "this page doesn't update in realtime, also it should start at the bottom and then scroll up
    // to see history like the history ledger page, filters still visible".
    const source = fixtureSource();
    let patch: (() => void) | null = null;
    let extra: LedgerEntry[] = [];
    const live: TexPageSource = {
      ...source,
      ledger: async (chat, q) => {
        const r = await source.ledger(chat, q);
        return r.kind === "ok" && q.before === LATEST ? { ...r, value: { ...r.value, entries: [...extra, ...r.value.entries] } } : r;
      },
      live: (chat, onPatch, onLive) => {
        patch = () => onPatch({ t: "patch", section: "earlier" } as never);
        return source.live(chat, onPatch, onLive);
      },
    };
    await render(live, { chat: "me", view: "history" });
    const scroll = byTestId("history-file-scroll")!;
    const head = byTestId("history-file-head")!;
    // The filters stay where they are as the lines move: above the scroller, never in it, and the page itself holds still.
    expect(scroll.contains(head)).toBe(false);
    expect(head.querySelector('[data-testid="tex-history-show-texts"]')).not.toBeNull();
    expect(head.textContent).toContain("History");
    expect(byTestId("tex-page")!.contains(scroll)).toBe(true);
    // The newest line is the last one.
    const lines = () => [...scroll.querySelectorAll('[data-testid^="tex-history-entry-"]')].map((e) => e.getAttribute("data-testid"));
    expect(lines().indexOf("tex-history-entry-me-e1")).toBeLessThan(lines().indexOf("tex-history-entry-me-e6"));
    // A judge's verdict written while the page is open arrives without a reload, at the bottom.
    extra = [{ v: 1, seq: 99, id: "me-e99", at: Date.parse("2026-11-02T14:30:00Z"), kind: "text", from: { kind: "tex" }, turn: "t99", text: "A new answer, just now.", delivered: true } as LedgerEntry];
    expect(patch).not.toBeNull();
    act(() => patch!());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    await tick();
    expect(text()).toContain("A new answer, just now.");
    expect(lines().at(-1)).toBe("tex-history-entry-me-e99");
  });

  test("the day and what is shown are asked of the gateway", async () => {
    const source = fixtureSource();
    const asked: LedgerQuery[] = [];
    await render({ ...source, ledger: (chat, q) => (asked.push(q), source.ledger(chat, q)) }, { chat: "me", view: "history" });
    expect(asked).toEqual([{ kinds: SHOWN_KINDS, day: "2026-11-02", before: LATEST }]);
    // A job's work is always read, folded under its own line: Tex · Minion 1, its state and how much it did.
    const job = byTestId("tex-history-entry-job:2026-11-02:maritime")?.textContent ?? "";
    expect(job).toBe("9:10 AMTex · Minion 1▾ Research maritime.shrunning3 steps");
    expect(byTestId("tex-history-entry-calls:me-j2")?.textContent).toBe("▸ 2 tool calls · browse ×2 · 1 failed");
    expect(byTestId("tex-history-entry-me-j4")?.textContent).toBe("advisor · Pricing page is the one to read; skip the blog.");
    await press("tex-history-entry-calls:me-j2");
    expect(byTestId("tex-history-entry-me-j3")?.textContent).toBe("✕ browse · failed");
    expect(text()).not.toContain("The blog is old");
    await press("tex-history-show-thinking");
    expect(text()).toContain("advisor thinking · They want cost first. The blog is old.");
    expect(byTestId("tex-history-job-steps-maritime")?.textContent).toContain("Read their docs, then compare pricing.");
    expect(asked.at(-1)!.kinds).toEqual(["text", "tool", "judge", "thinking", "said", "note", "advisor", "mail_check", "job"]);
    expect(asked.at(-1)!.jobs).toBeUndefined();
    // Folded away on a tap.
    await press("tex-history-entry-job:2026-11-02:maritime");
    expect(byTestId("tex-history-job-steps-maritime")).toBeNull();
    expect(byTestId("tex-history-show-jobs")).toBeNull();
    expect(text()).toContain("Look at today's calendar");
    await press("tex-history-show-thinking");
    await press("tex-history-show-tools");
    expect(asked.at(-1)!.kinds).toEqual(["text", "note", "advisor", "mail_check", "job"]);
    expect(text()).not.toContain("calendar_events");
    await press("tex-history-show-tools");
    await press("tex-history-day-choice");
    await press("tex-history-day-choice-option-yesterday");
    expect(asked.at(-1)).toEqual({ kinds: SHOWN_KINDS, day: "2026-11-01", before: LATEST });
    expect(text()).toContain("Your water bill is due Tuesday");
    expect(text()).not.toContain("Standup at 10");
    await press("tex-history-day-choice");
    await press("tex-history-day-choice-option-all");
    expect(asked.at(-1)).toEqual({ kinds: SHOWN_KINDS, before: LATEST });
    // Every day, read as a chat: the oldest at the top, each in the order it happened, the newest at the bottom.
    expect(byTestId("tex-history-day-2026-11-02")).not.toBeNull();
    expect(text().indexOf("Your water bill")).toBeLessThan(text().indexOf("Standup at 10"));
    await press("tex-history-day-choice");
    await press("tex-history-day-choice-option-pick");
    const before = asked.length;
    await type("tex-history-day", "2026-11");
    expect(asked.length).toBe(before);
    await type("tex-history-day", "2026-10-30");
    expect(asked.at(-1)).toEqual({ kinds: SHOWN_KINDS, day: "2026-10-30", before: LATEST });
    expect(byTestId("tex-history-empty")).not.toBeNull();
  });

  test("Show older reads on before the last page, and one still reading when a filter changes is dropped", async () => {
    const source = fixtureSource();
    const pending: (() => void)[] = [];
    let hold = true;
    const paged: TexPageSource = {
      ...source,
      ledger: async (chat, q) => {
        const read = await source.ledger(chat, { ...q, before: LATEST });
        if (read.kind !== "ok") return read;
        const first = q.before === LATEST;
        // The chat's own lines only: this is about paging, not jobs.
        const own = read.value.entries.filter((e) => e.jobId === undefined);
        const page = first ? own.slice(0, 2) : own.slice(2);
        if (!first && hold) {
          hold = false;
          await new Promise<void>((r) => pending.push(r));
        }
        return { kind: "ok", value: { ...read.value, entries: page, ...(first && own.length > 2 ? { older: 4 } : {}) } };
      },
    };
    await render(paged, { chat: "me", view: "history" });
    expect(text()).toContain("Standup at 10");
    expect(text()).not.toContain("what's on my calendar today?");
    await press("tex-history-more");
    await press("tex-history-show-thinking");
    act(() => pending.forEach((r) => r()));
    await tick();
    // The held page was read under the old filter: none of it is added to this one.
    expect(text()).not.toContain("what's on my calendar today?");
    expect(text()).not.toContain("Look at today's calendar");
    await press("tex-history-show-thinking");
    await press("tex-history-more");
    expect(text()).toContain("what's on my calendar today?");
    expect(byTestId("tex-history-more")).toBeNull();
  });

  test("History is the lines alone, with no view menu over them", async () => {
    await render(fixtureSource(), { chat: "me", view: "history" });
    expect(byTestId("tex-history-tab")).toBeNull();
    expect(byTestId("tex-sees")).toBeNull();
  });

  test("What Tex sees is its own page under Behind the scenes, with the settings that shaped it and the chat as rendered", async () => {
    await render(fixtureSource());
    await press("tex-behind-sees");
    expect(byTestId("tex-sees-page")).not.toBeNull();
    expect(text()).toContain("Shown tool results");
    expect(byTestId("tex-sees-setting-toolResults")?.textContent).toContain("No");
    expect(byTestId("tex-sees-setting-heldBack")).toBeNull();
    expect(byTestId("tex-sees-text")?.textContent).toContain("(used: calendar_events, read_note)");
  });

  test("a group's history says whose it is and names who sent each text, and a chat that is not yours shows none of it", async () => {
    await render(fixtureSource(), { chat: "g-team", view: "history" });
    expect(text()).toContain("History · Team Night");
    expect(byTestId("tex-history-entry-g-team-e1")?.textContent).toBe("9:02 AMAdawhat's on my calendar today?");
    // Cy's 👍 sits under the text it was on, never as a line of its own.
    expect(byTestId("tex-history-entry-g-team-e7")).toBeNull();
    expect(byTestId("tex-history-reactions-g-team-e6")?.textContent).toBe("👍 Cy");
    expect(byTestId("tex-history-entry-g-team-e8")?.textContent).toBe("9:05 AMBo↳ Ada: what's on my calendar today?I'll bring snacks to standup");
    const source = fixtureSource();
    expect((await source.ledger("g-someone-elses", {})).kind).toBe("notYours");
    expect((await source.sees("g-someone-elses")).kind).toBe("notYours");
  });
});

describe("reading the history from the gateway", () => {
  test("the source posts the ledger route, raw with its filters, or what Tex sees", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const answers = [
      { manifest: { schema: "tex-ledger", version: 1, count: 1 }, entries: [{ id: "e1", at: 1, kind: "note", text: "hi" }, { id: 5 }], before: 7 },
      { settings: { toolResults: false, odd: { no: 1 } }, text: "[9:02 AM] You: hi" },
    ];
    const source = gatewaySource({
      endpoint: "https://mcp.example.test/mcp",
      handle: "ada",
      token: async () => "t",
      fetch: (async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { status: 200, json: async () => answers[posts.length - 1] };
      }) as unknown as typeof fetch,
    });
    const raw = await source.ledger("me", { kinds: ["tool"], day: "2026-11-02", before: 3 });
    expect(posts[0]).toEqual({ url: "https://mcp.example.test/tex/page/ledger", body: { handle: "ada", chat: "me", view: "raw", kinds: ["tool"], day: "2026-11-02", before: 3 } });
    expect(raw.kind === "ok" && raw.value.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(raw.kind === "ok" && raw.value.older).toBe(7);
    const sees = await source.sees("me");
    expect(posts[1]!.body).toEqual({ handle: "ada", chat: "me", view: "sees" });
    expect(sees).toEqual({ kind: "ok", value: { settings: { toolResults: false }, text: "[9:02 AM] You: hi" } });
  });

  test("answers are read field by field", () => {
    expect(readLedgerPage(null)).toBeNull();
    expect(readLedgerPage({ entries: "x" })).toEqual({ manifest: null, entries: [] });
    expect(readLedgerSees({ settings: {} })).toBeNull();
    expect(entryLine({ id: "a", at: 1, kind: "reply", clean: true })).toBe("Answer · clean");
    expect(entryLine({ id: "b", at: 1, kind: "text", from: { kind: "tex" }, text: "a  b\nc" })).toBe("Tex: a b c");
  });
});
