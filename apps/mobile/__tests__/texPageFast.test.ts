/**
 * @jest-environment jsdom
 */

/**
 * The Tex page loads fast (the owner, 2026-11-04: "make the hub page load
 * fast ... a cheap browser check, tiles loaded beside the page, and instant
 * revisits"): the first screen draws without waiting for the tiles, the tiles
 * fill in beside it, a tile that never answers falls back to its title, and
 * coming back draws the last copy at once, Tex's computer excepted.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-04):
 *  1. `load` awaiting the tiles before the first screen → "draws the first
 *     screen before its tiles are read" fails.
 *  2. The kept copy not consulted on mount → "coming back draws the last copy
 *     at once" fails.
 *  3. The kept copy's computer line drawn as known → "coming back draws the
 *     last copy at once, but never Tex's computer from it" fails.
 *  4. `forgetTexPages` a no-op → "signing out forgets
 *     every kept page" fails (it is called beside every clear in `offline/forget.ts`).
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { fixtureNow, fixtureSource } from "../features/tex/page/texPageFixture";
import { forgetTexPages, keptOverview } from "../features/tex/page/texPageMemory";
import { gatewaySource, type OverviewPart, type TexPageSource } from "../features/tex/page/texPageSource";
import { TILES_WAIT_MS, useTexPage } from "../features/tex/page/useTexPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const HANDLE = "seyi";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetTexPages();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ source, start, handle }: { source: TexPageSource; start: Place; handle?: string }) {
  const [place, setPlace] = useState<Place>(start);
  const page = useTexPage(source, place.chat, handle);
  return createElement(TexPageBody, { source, page, place, go: setPlace, computer: null, openComputer: () => {}, now: fixtureNow });
}

const tick = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function render(source: TexPageSource, handle?: string) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source, start: { chat: "me" }, handle }))));
  await tick();
}

const text = () => container.textContent ?? "";
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** The fixture, with each part's answer held until `release(part)`, and every ask recorded. */
function heldSource() {
  const base = fixtureSource();
  const asked: Array<OverviewPart | "all"> = [];
  const waiting = new Map<string, Array<() => void>>();
  const source: TexPageSource = {
    ...base,
    async overview(chat, part) {
      asked.push(part ?? "all");
      await new Promise<void>((resolve) => waiting.set(part ?? "all", [...(waiting.get(part ?? "all") ?? []), resolve]));
      return base.overview(chat, part);
    },
  };
  const release = async (part: OverviewPart) => {
    for (const go of waiting.get(part) ?? []) go();
    waiting.delete(part);
    await tick();
  };
  return { source, asked, release };
}

describe("the Tex page loads fast", () => {
  test("asks for the first screen and the tiles side by side, never the whole page at once", async () => {
    const held = heldSource();
    await render(held.source);
    // Both asked before either answered. (The live feed coming up reads once more, after.)
    expect(held.asked.slice(0, 2).sort()).toEqual(["core", "tiles"]);
    expect(held.asked).not.toContain("all");
  });

  test("draws the first screen before its tiles are read", async () => {
    const held = heldSource();
    await render(held.source);
    await held.release("core");
    expect(text()).toContain("Working on 2 jobs · 1 needs you");
    expect(text()).toContain("Minions · 2 of 3 busy");
    // Each tile shows its title and a bar where its line will be, and nothing below moves when it lands.
    expect(text()).toContain("Routines");
    expect(text()).not.toContain("3 on · next 8:00");
    expect(byTestId("tex-tile-routines-wait")).not.toBeNull();
    expect(byTestId("tex-tile-computer-wait")).not.toBeNull();
    // Still tappable while it waits.
    expect(byTestId("tex-tile-routines")?.getAttribute("role")).toBe("button");
  });

  test("fills the tiles in beside the page, whichever lands first", async () => {
    const held = heldSource();
    await render(held.source);
    await held.release("tiles");
    await held.release("core");
    expect(text()).toContain("3 on · next 8:00");
    expect(byTestId("tex-tile-routines-wait")).toBeNull();
    expect(byTestId("tex-tile-computer-wait")).toBeNull();
  });

  test("a tile that never answers shows its title alone after the wait, never an error", async () => {
    const held = heldSource();
    await render(held.source);
    await held.release("core");
    expect(byTestId("tex-tile-routines-wait")).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, TILES_WAIT_MS + 50));
    });
    expect(byTestId("tex-tile-routines-wait")).toBeNull();
    expect(text()).toContain("Routines");
    expect(text()).not.toContain("3 on · next 8:00");
  }, 10_000);

  test("coming back draws the last copy at once, but never Tex's computer from it", async () => {
    await render(fixtureSource(), HANDLE);
    expect(keptOverview(HANDLE, "me")).not.toBeNull();
    act(() => root.render(createElement("div")));
    // Back again, with nothing answering yet.
    const held = heldSource();
    await render(held.source, HANDLE);
    expect(text()).toContain("Working on 2 jobs · 1 needs you");
    expect(text()).toContain("3 on · next 8:00");
    expect(byTestId("tex-tile-routines-wait")).toBeNull();
    expect(byTestId("tex-tile-computer-wait")).not.toBeNull();
    await held.release("tiles");
    expect(byTestId("tex-tile-computer-wait")).toBeNull();
  });

  test("signing out forgets every kept page", async () => {
    await render(fixtureSource(), HANDLE);
    expect(keptOverview(HANDLE, "me")).not.toBeNull();
    forgetTexPages();
    expect(keptOverview(HANDLE, "me")).toBeNull();
  });

  test("each part asks the gateway for its own sections, and a group link only for the chat list", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const source = gatewaySource({
      endpoint: "https://mcp.context.test/mcp",
      handle: HANDLE,
      token: async () => "cat_test_token",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ chat: { key: "me", name: "Just you" } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await source.overview("me", "core");
    await source.overview("me", "tiles");
    await source.overview("me", "chats");
    await source.overview("me");
    expect(bodies.map((b) => b.sections)).toEqual([
      ["chats", "chat", "status", "thinking", "thinkingToday", "minions", "earlier", "earlierWeek", "behind"],
      ["chat", "tiles"],
      ["chats", "chat"],
      undefined,
    ]);
  });
});
