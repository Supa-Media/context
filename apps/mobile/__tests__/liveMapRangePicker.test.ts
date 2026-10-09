/**
 * @jest-environment jsdom
 */

/**
 * The map's bar and the custom range picker, as a person meets them. The bar
 * has no "Back to live" any more: Live is in the row. Custom opens the picker,
 * whose Replay hands the stretch to the page, and Escape closes it. On a phone
 * the calendar segment is the same picker, named "Pick a stretch of time".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// The days hook mints a grant through Convex; with no endpoint it asks nothing.
jest.mock("convex/react", () => ({ useAction: () => async () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MapPageState } from "../features/console/map/live/hooks/useMapPage";
import { MapBar } from "../features/console/map/live/ui/MapBar";
import { RangePicker } from "../features/console/map/live/ui/RangePicker";
import { DAY_MS, startOfDay, type Stretch } from "../features/console/map/live/replayClock";

const NOW = new Date(2026, 9, 13, 15, 30).getTime();

function pageWith(extra: Record<string, unknown> = {}) {
  const calls: { playStretch: Stretch[]; setMode: string[] } = { playStretch: [], setMode: [] };
  const page = {
    mode: "live",
    setMode: (m: string) => calls.setMode.push(m),
    view: "map",
    setView: () => {},
    scope: "one",
    setScope: () => {},
    many: true,
    reducedMotion: true,
    follow: null,
    custom: null,
    now: NOW,
    events: [],
    workspaceIds: ["ws-a"],
    historyEndpoint: null,
    localHistoryDays: null,
    playStretch: (s: Stretch) => calls.playStretch.push(s),
    ...extra,
  } as unknown as MapPageState;
  return { page, calls };
}

const roots: Root[] = [];
async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}
const find = (host: ParentNode, testID: string) => host.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("the desktop bar", () => {
  test("Live, the past 24 hours, the past week and Custom are in one row, and there is no Back to live", async () => {
    const { page } = pageWith();
    const host = await mount(createElement(MapBar, { page, compact: false }));
    const text = host.textContent ?? "";
    expect(text).toContain("Live");
    expect(text).toContain("Past 24 hours");
    expect(text).toContain("Past week");
    expect(find(host, "map-custom")!.textContent).toContain("Custom");
    expect(find(host, "map-back-to-live")).toBeNull();
    expect(text).not.toContain("Back to live");
  });

  test("a custom stretch that is playing is named on its chip", async () => {
    const from = startOfDay(NOW - 11 * DAY_MS);
    const { page } = pageWith({ mode: "custom", custom: { from, to: NOW, open: true } });
    const host = await mount(createElement(MapBar, { page, compact: false }));
    expect(find(host, "map-custom")!.textContent).toContain("– now");
  });
});

describe("the phone bar", () => {
  test("the calendar segment is named for what it does, and offers no words while no stretch is picked", async () => {
    const { page } = pageWith();
    const host = await mount(createElement(MapBar, { page, compact: true }));
    const calendar = find(host, "map-when-custom")!;
    expect(calendar.getAttribute("aria-label")).toBe("Pick a stretch of time");
    expect(host.textContent).toContain("24h");
    expect(host.textContent).toContain("Week");
    expect(host.textContent).toContain("This one");
  });
});

describe("the range picker", () => {
  test("Replay hands the stretch to the page, from the first day to now, and closes", async () => {
    const { page, calls } = pageWith();
    let closed = 0;
    await mount(createElement(RangePicker, { page, compact: false, anchor: null, onClose: () => closed++ }));
    const title = document.body.textContent ?? "";
    expect(title).toContain("Replay a stretch of time");
    expect(title).toContain("Nothing has happened here yet");
    expect(title).toContain("0 changes · plays in 30 s");
    const replay = Array.from(document.querySelectorAll('[role="button"]')).find((b) => b.textContent === "Replay")!;
    await act(async () => (replay as HTMLElement).click());
    expect(calls.playStretch).toHaveLength(1);
    expect(calls.playStretch[0]).toMatchObject({ open: true });
    expect(closed).toBe(1);
  });

  test("Escape closes it", async () => {
    const { page } = pageWith();
    let closed = 0;
    await mount(createElement(RangePicker, { page, compact: false, anchor: null, onClose: () => closed++ }));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(1);
  });
});
