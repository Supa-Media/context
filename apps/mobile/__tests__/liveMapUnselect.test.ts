/**
 * @jest-environment jsdom
 */

/**
 * UNSELECTING A NOTE ON THE MAP (Dev2, 2026-11-05: "there should be a better
 * way of unselecting than just clicking on empty space. we click on empty
 * space to look around").
 *
 * A click on the selected note again unselects it, Esc does, and the chip's ×
 * (`peek.close`) does; a click on empty space is not even wired. Find and a
 * link in the preview show a note and never toggle it off.
 *
 * Sabotage record: `onTapNote` opening whatever it is given → "a second click
 * on the selected note unselects it" fails; the Esc listener dropped → "Esc
 * unselects" fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMapPeek, type MapPeek } from "../features/console/map/live/hooks/useMapPeek";
import type { MapPageState } from "../features/console/map/live/hooks/useMapPage";
import { forgetMapMemory } from "../features/console/map/live/peek/mapMemory";

const page = { selected: null, scope: "one", engineRef: { current: null } } as unknown as MapPageState;
const NOTE = { workspaceId: "ws-a", path: "areas/plan.md", at: { x: 10, y: 10 } };
const OTHER = { workspaceId: "ws-a", path: "areas/other.md", at: null };

let latest: MapPeek;
function Probe() {
  latest = useMapPeek(page);
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  forgetMapMemory();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const shown = () => latest.peek?.path ?? null;

describe("unselecting a note on the map", () => {
  test("a second click on the selected note unselects it; a click on another switches", async () => {
    await act(async () => latest.onTapNote(NOTE));
    expect(shown()).toBe(NOTE.path);
    await act(async () => latest.onTapNote(OTHER));
    expect(shown()).toBe(OTHER.path);
    await act(async () => latest.onTapNote(OTHER));
    expect(shown()).toBeNull();
  });

  test("Esc unselects", async () => {
    await act(async () => latest.onTapNote(NOTE));
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(shown()).toBeNull();
  });

  test("the chip's × unselects, and Find never toggles a note off", async () => {
    await act(async () => latest.show(NOTE));
    await act(async () => latest.show(NOTE));
    expect(shown()).toBe(NOTE.path);
    await act(async () => latest.close());
    expect(shown()).toBeNull();
  });

  test("nothing on the map unselects on a click on empty space", () => {
    expect((latest as unknown as Record<string, unknown>).onTapEmpty).toBeUndefined();
  });
});
