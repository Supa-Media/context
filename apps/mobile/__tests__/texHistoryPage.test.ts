/**
 * @jest-environment jsdom
 */

/**
 * The chat's history file on the Tex page (decided by the owner, 2026-11-02:
 * one history file, shown raw with filters, and a view of exactly what Tex
 * sees): reached from Behind the scenes, filtered by kind and day through the
 * gateway, searched on the page, each entry opening to its raw JSON, and
 * "What Tex sees" with the settings that shaped it.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-02):
 *  1. The kind filter not sent to the gateway → "the kind filter and a whole
 *     day are asked of the gateway" fails.
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

jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { fixtureNow, fixtureSource } from "../features/tex/page/texPageFixture";
import { entryLine, readLedgerPage, readLedgerSees } from "../features/tex/page/texPageLedger";
import { gatewaySource, type TexPageSource } from "../features/tex/page/texPageSource";
import { LATEST, type LedgerQuery } from "../features/tex/page/texPageTypes";
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

describe("the chat's history file", () => {
  test("is one tap from Behind the scenes, and shows every entry as kept, newest first", async () => {
    await render(fixtureSource());
    await press("tex-behind-history");
    expect(byTestId("tex-history")).not.toBeNull();
    expect(text()).toContain("tex-ledger v1 · 6 entries");
    expect(text()).toContain("Person: what's on my calendar today?");
    expect(text()).toContain("calendar_events · ok · 420 ms");
    expect(text()).toContain("read_note · result withheld (another workspace)");
    expect(text().indexOf("Tex: Standup at 10")).toBeLessThan(text().indexOf("Person: what's on my calendar today?"));
    await press("tex-history-entry-me-e3");
    const raw = byTestId("tex-history-raw-me-e3")?.textContent ?? "";
    expect(JSON.parse(raw)).toMatchObject({ kind: "tool", name: "calendar_events", args: { day: "today" } });
  });

  test("the kind filter and a whole day are asked of the gateway; search stays on the page", async () => {
    const source = fixtureSource();
    const asked: LedgerQuery[] = [];
    await render({ ...source, ledger: (chat, q) => (asked.push(q), source.ledger(chat, q)) }, { chat: "me", view: "history" });
    expect(asked).toEqual([{ before: LATEST }]);
    await press("tex-history-kind");
    await press("tex-history-kind-option-tool");
    expect(asked.at(-1)).toEqual({ kinds: ["tool"], before: LATEST });
    expect(text()).not.toContain("what's on my calendar today?");
    const before = asked.length;
    await type("tex-history-day", "2026-11");
    expect(asked.length).toBe(before);
    await type("tex-history-day", "2026-11-01");
    expect(asked.at(-1)).toEqual({ kinds: ["tool"], day: "2026-11-01", before: LATEST });
    expect(byTestId("tex-history-empty")).not.toBeNull();
    await type("tex-history-day", "");
    const reads = asked.length;
    await type("tex-history-search", "read_note");
    expect(asked.length).toBe(reads);
    expect(text()).toContain("read_note");
    expect(text()).not.toContain("calendar_events");
  });

  test("Show older reads on before the last page, and one still reading when the filter changes is dropped", async () => {
    const source = fixtureSource();
    const pending: (() => void)[] = [];
    let hold = true;
    const paged: TexPageSource = {
      ...source,
      ledger: async (chat, q) => {
        const read = await source.ledger(chat, { ...q, before: LATEST });
        if (read.kind !== "ok") return read;
        const first = q.before === LATEST;
        const page = first ? read.value.entries.slice(0, 3) : read.value.entries.slice(3);
        if (!first && hold) {
          hold = false;
          await new Promise<void>((r) => pending.push(r));
        }
        return { kind: "ok", value: { ...read.value, entries: page, ...(first && read.value.entries.length > 3 ? { older: 4 } : {}) } };
      },
    };
    await render(paged, { chat: "me", view: "history" });
    expect(text()).toContain("Standup at 10");
    expect(text()).not.toContain("what's on my calendar today?");
    await press("tex-history-more");
    await press("tex-history-kind");
    await press("tex-history-kind-option-thinking");
    act(() => pending.forEach((r) => r()));
    await tick();
    expect(text()).toContain("Look at today's calendar");
    expect(text()).not.toContain("what's on my calendar today?");
    await press("tex-history-kind");
    await press("tex-history-kind-option-all");
    await press("tex-history-more");
    expect(text()).toContain("what's on my calendar today?");
    expect(byTestId("tex-history-more")).toBeNull();
  });

  test("What Tex sees shows the settings that shaped it and the chat as rendered", async () => {
    await render(fixtureSource(), { chat: "me", view: "history" });
    await press("tex-history-tab");
    await press("tex-history-tab-option-sees");
    expect(text()).toContain("Shown tool results");
    expect(byTestId("tex-sees-setting-toolResults")?.textContent).toContain("No");
    expect(byTestId("tex-sees-setting-heldBack")?.textContent).toContain("Yes");
    expect(byTestId("tex-sees-text")?.textContent).toContain("(used: calendar_events, read_note)");
  });

  test("a group's history says whose it is, and a chat that is not yours shows none of it", async () => {
    await render(fixtureSource(), { chat: "g-team", view: "history" });
    expect(text()).toContain("Everything said and done in Team Night");
    expect(text()).toContain("Ada: what's on my calendar today?");
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
