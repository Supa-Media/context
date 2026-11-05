/**
 * @jest-environment jsdom
 */

/**
 * THE MAP'S TABS IN THE CONSOLE'S RIGHT PANEL (Dev2, 2026-11-04: the map's
 * own column merged into the meetings panel, so one button hides it all).
 *
 * While the map is open the panel leads with Activity; a note clicked on the
 * map adds Note and brings it forward; the map leaving takes both away and
 * the panel is Meetings again. Meetings stays a tap away throughout.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `AsidePanel` ignoring `map` in `visibleAsideTabs` → "the open map leads
 *     with Activity" fails.
 *  2. The `noteKey` effect dropped → "a clicked note brings Note forward" fails.
 *  4. `AsidePanel` ignoring `asideFolded` → both folding tests fail.
 *  3. The map's effects declared before `started`'s → "a panel opened on the
 *     map shows Activity" fails (the fixture showed Meetings this way).
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: null, records: [], canContinue: false, ending: null, audio: {}, offline: false }),
  useTick: () => 0,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { MapSideProvider, useOfferMapSide, type MapSide } from "../features/console/aside/mapSide";
import { FrameContext, type FrameApi } from "../features/app/appFrame/context";
import { initialFrame } from "../features/app/frame";

function Offer({ side }: { side: MapSide | null }) {
  useOfferMapSide(side);
  return null;
}

const tag = (id: string): ReactNode => createElement(Text, { testID: id }, id);
const mapOpen = (noteKey: string | null): MapSide => ({
  activity: tag("activity-body"),
  note: noteKey === null ? null : tag("note-body"),
  noteKey,
});

let root: Root;
let host: HTMLDivElement;
const byTest = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);
const tabs = () => Array.from(host.querySelectorAll('[role="tab"]')).map((el) => el.textContent);

async function show(side: MapSide | null, offering = true, started: number | null = null, panel = true) {
  await act(async () =>
    root.render(
      createElement(
        MapSideProvider,
        null,
        offering ? createElement(Offer, { side }) : null,
        panel ? createElement(AsidePanel, { started, onOpenNote: null }) : null,
      ),
    ),
  );
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the map's tabs in the right panel", () => {
  test("with the map shut the panel is Meetings alone", async () => {
    await show(null);
    expect(tabs()).toEqual(["Meetings"]);
    expect(byTest("activity-body")).toHaveLength(0);
  });

  test("the open map leads with Activity, and Meetings is a tap away", async () => {
    await show(mapOpen(null));
    expect(tabs()).toEqual(["Activity", "Meetings"]);
    expect(byTest("activity-body")).toHaveLength(1);
    await act(async () => (byTest("aside-tab-meetings")[0] as HTMLElement).click());
    expect(byTest("activity-body")).toHaveLength(0);
  });

  test("a panel opened on the map shows Activity, though a meeting was asked for earlier", async () => {
    // The map first; the panel opened over it afterwards, as the top bar's button does.
    await show(mapOpen(null), true, 1, false);
    await show(mapOpen(null), true, 1);
    expect(byTest("activity-body")).toHaveLength(1);
  });

  test("a clicked note brings Note forward; another click on Activity goes back", async () => {
    await show(mapOpen(null));
    await show(mapOpen("ws\na.md"));
    expect(tabs()).toEqual(["Activity", "Note", "Meetings"]);
    expect(byTest("note-body")).toHaveLength(1);
    await act(async () => (byTest("aside-tab-activity")[0] as HTMLElement).click());
    expect(byTest("activity-body")).toHaveLength(1);
    // A different note clicked brings Note forward again.
    await show(mapOpen("ws\nb.md"));
    expect(byTest("note-body")).toHaveLength(1);
  });

  test("the note closed falls back to Activity, and the map leaving to Meetings", async () => {
    await show(mapOpen("ws\na.md"));
    await show(mapOpen(null));
    expect(tabs()).toEqual(["Activity", "Meetings"]);
    expect(byTest("activity-body")).toHaveLength(1);
    await show(null, false);
    expect(tabs()).toEqual(["Meetings"]);
    expect(byTest("aside-map-activity")).toHaveLength(0);
  });
});

describe("folding the panel (Dev2, 2026-11-05: 'collapsable')", () => {
  // A frame of its own: the panel reads `asideFolded` and sets it, nothing else.
  function Framed({ side }: { side: MapSide | null }) {
    const [folded, setFolded] = useState(false);
    const frame = { state: { ...initialFrame, asideOpen: true, asideFolded: folded }, setAsideFolded: setFolded } as unknown as FrameApi;
    return createElement(
      FrameContext.Provider,
      { value: frame },
      createElement(Offer, { side }),
      createElement(AsidePanel, { started: null, onOpenNote: null }),
    );
  }
  const framed = async (side: MapSide | null) =>
    act(async () => root.render(createElement(MapSideProvider, null, createElement(Framed, { side }))));

  test("the fold button folds it to a strip of its tabs, and a tab there unfolds it on that tab", async () => {
    await framed(mapOpen("ws\na.md"));
    expect(byTest("note-body")).toHaveLength(1);
    await act(async () => (byTest("aside-fold")[0] as HTMLElement).click());
    expect(byTest("aside-strip")).toHaveLength(1);
    expect(byTest("note-body")).toHaveLength(0);
    expect(["activity", "note", "meetings"].map((k) => byTest(`aside-strip-${k}`).length)).toEqual([1, 1, 1]);
    await act(async () => (byTest("aside-strip-activity")[0] as HTMLElement).click());
    expect(byTest("aside-strip")).toHaveLength(0);
    expect(byTest("activity-body")).toHaveLength(1);
  });

  test("the strip's top button unfolds it as it was", async () => {
    await framed(mapOpen("ws\na.md"));
    await act(async () => (byTest("aside-fold")[0] as HTMLElement).click());
    await act(async () => (byTest("aside-unfold")[0] as HTMLElement).click());
    expect(byTest("note-body")).toHaveLength(1);
  });
});
