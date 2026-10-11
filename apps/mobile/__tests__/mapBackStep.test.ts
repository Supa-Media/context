/**
 * @jest-environment jsdom
 */

/**
 * `‹` from a note opened off the live map goes back to the map. The map is
 * `?map=1` over Browse, so the step is the params the Map button sets, and a
 * step on from the map to a note closes it again. Reported by Dev2
 * (2026-10-09): "clicking back doesn't take me to where I was in the map".
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConsoleHistory } from "../features/console/layout/useConsoleHistory";
import type { ConsoleRoute } from "../features/console/nav";

type Screen = { selectedPath: string | null; mapOpen: boolean };
const calls: unknown[] = [];
const router = {
  setParams: (p: unknown) => calls.push(["setParams", p]),
  replace: (h: unknown) => calls.push(["replace", h]),
  push: (h: unknown) => calls.push(["push", h]),
} as never;
const route: ConsoleRoute = { kind: "context", slug: "seyi", view: "browse" } as ConsoleRoute;

let root: Root | null = null;
let step: ((delta: -1 | 1) => void) | null = null;
const selected: string[] = [];

function Probe({ screen }: { screen: Screen }) {
  const data = {
    selectedContextId: "ws-p",
    contexts: [{ id: "ws-p", slug: "seyi" }],
    files: {
      selectedPath: screen.selectedPath,
      select: (path: string) => {
        selected.push(path);
        return true;
      },
    },
  } as never;
  step = useConsoleHistory({ data, router, route, openSettingsSection: null, mapOpen: screen.mapOpen }).step;
  return null;
}

async function show(screen: Screen) {
  await act(async () => root!.render(createElement(Probe, { screen })));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  calls.length = 0;
  selected.length = 0;
});

describe("back to the map", () => {
  test("a note, the map, a note from the map: back opens the map, and forward closes it on the note", async () => {
    root = createRoot(document.createElement("div"));
    await show({ selectedPath: "1-projects/plan.md", mapOpen: false });
    await show({ selectedPath: "1-projects/plan.md", mapOpen: true });
    await show({ selectedPath: "1-projects/launch.md", mapOpen: false });

    await act(async () => step!(-1));
    expect(calls).toEqual([["setParams", { map: "1", changes: undefined, settings: undefined }]]);
    expect(selected).toEqual([]);

    calls.length = 0;
    await show({ selectedPath: "1-projects/launch.md", mapOpen: true });
    await act(async () => step!(1));
    expect(selected).toEqual(["1-projects/launch.md"]);
    expect(calls).toEqual([["setParams", { map: undefined }]]);
  });
});
