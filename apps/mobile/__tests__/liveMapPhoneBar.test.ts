/**
 * @jest-environment jsdom
 */

/**
 * The phone map's bar fills the width. `PhoneMap` lays it over the canvas in a
 * box with `alignItems: "flex-start"`, and its segmented tracks share a row by
 * `flexBasis: 0`, so a bar that did not stretch itself drew every track at
 * no width: a dot and two slivers where Live / Today / Week and Map / Columns
 * should be (Dev2's phone, 2026-10-09). The replay moved into the map's
 * settings (Dev2, 2026-11-04), so the bar holds the layout, the workspaces
 * and the gear.
 */

import { describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MapPageState } from "../features/console/map/live/hooks/useMapPage";
import { MapBar } from "../features/console/map/live/ui/MapBar";

const page = {
  mode: "live",
  setMode: () => {},
  view: "map",
  setView: () => {},
  scope: "one",
  setScope: () => {},
  many: true,
  reducedMotion: true,
  follow: null,
} as unknown as MapPageState;

describe("the phone map bar", () => {
  test("stretches across the map, whatever its parent aligns to", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(MapBar, { page, onSettings: () => {} })));
    const bar = host.querySelector('[data-testid="map-bar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(getComputedStyle(bar).alignSelf).toBe("stretch");
    // Columns is gone (Dev2, 2026-11-05), so there is no layout switch.
    expect(host.querySelector('[data-testid="map-view"]')).toBeNull();
    for (const id of ["map-scope", "map-settings-open"]) {
      expect(host.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    await act(async () => root.unmount());
  });
});
