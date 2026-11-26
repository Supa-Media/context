/**
 * @jest-environment jsdom
 */

/**
 * HOVERING AN AREA'S TREND SAYS EACH POINT'S VALUE AND DATE.
 *
 * The owner, 2026-11-26: "when hovering over the timeline we should see the
 * value and the date please". A sheet row's date and a worked-out period are
 * said in words; a week is its first and last day, an hour keeps its hour.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PanelTrend } from "../features/console/files/folderPage/areas/PanelTrend";
import { trendGeometry } from "../features/console/files/folderPage/areas/Trend";
import { periodDateWords, rowDateWords } from "../features/console/files/folderPage/areas/trendPoints";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

describe("a trend point's date in words", () => {
  test("a sheet row's date", () => {
    expect(rowDateWords("2026-11-24")).toBe("Nov 24");
    expect(rowDateWords("")).toBe("");
    expect(rowDateWords("last week")).toBe("last week");
  });

  test("a worked-out period: a day is its day, a week its first and last day", () => {
    const at = (d: number, h = 0) => new Date(2026, 10, d, h).toISOString();
    expect(periodDateWords(at(24), at(25))).toBe("Nov 24");
    expect(periodDateWords(at(18), at(25))).toBe("Nov 18 – Nov 24");
    expect(periodDateWords(at(24, 15), at(24, 16))).toBe("Nov 24, 3 PM");
    expect(periodDateWords("", "")).toBe("");
  });
});

describe("the panel's trend", () => {
  test("pointing at a point shows its value and date; leaving hides it", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const points = [
      { value: "1", date: "Nov 18" },
      { value: "4", date: "Nov 19" },
      { value: "5", date: "Nov 20" },
    ];
    act(() => root.render(createElement(PanelTrend, { geometry: trendGeometry([1, 4, 5], 2)!, points, ink: "#000", width: 300, height: 64 })));
    live.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const find = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(find("area-panel-trend-tip")).toBeNull();
    act(() => {
      find("area-panel-trend-point-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(find("area-panel-trend-tip")?.textContent).toBe("4Nov 19");
    act(() => {
      find("area-panel-trend-point-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(find("area-panel-trend-tip")).toBeNull();
  });

  test("with no words for every point, nothing is offered to point at", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(PanelTrend, { geometry: trendGeometry([1, 4, 5], null)!, points: [], ink: "#000", width: 300, height: 64 })));
    live.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    expect(document.body.querySelector('[data-testid="area-panel-trend-point-0"]')).toBeNull();
  });
});
