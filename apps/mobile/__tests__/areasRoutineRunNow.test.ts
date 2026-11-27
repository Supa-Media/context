/**
 * @jest-environment jsdom
 */

/**
 * EVERY ROUTINE ROW HAS RUN NOW (Dev, 2026-11-27: "add the run now button for every routine").
 *
 * The button asks the gateway to send that routine to its bot out of turn, under the same cap its clock would honour,
 * and the row's last run shows what happened. Pressing it doesn't open the row's editor, a second tap before the
 * answer sends nothing twice, a paused routine or one that won't run has none, and a reader has none.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useQuery: () => [],
  useAction: () => async () => ({ ok: true, status: 200 }),
  useMutation: () => async () => null,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => {
    throw new Error("No fixture gateway session");
  },
}));

const runs: string[] = [];
let release: (() => void) | null = null;
const DAILY = "areas/finance/routines/daily/manager-loop.md";
const MONTHLY = "areas/finance/routines/monthly/month-end-close.md";
jest.mock("../features/console/files/folderPage/areas/useAreaRoutineState", () => {
  const { useState } = jest.requireActual<typeof import("react")>("react");
  return {
    useAreaRoutineState: () => {
      const [state, setState] = useState<unknown>({ week: "2026-11-23", routines: [], usage: [] });
      return {
        state,
        run: async (path: string) => {
          runs.push(path);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          setState({ week: "2026-11-23", routines: [{ path, area: "areas/finance", nextAt: null, lastAt: Date.now(), outcome: "held", bot: "Grok Bot", answeredAt: null, problem: null }], usage: [] });
          return null;
        },
      };
    },
  };
});

import { act } from "react";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { all, entry, host, mount, one, press, strip, unmountAll, windowOf } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: { agents: ["Grok Bot"] } },
  { path: "areas/bots/grok-bot/about.md", properties: { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi", works_in: ["areas/finance · 20%"] } },
  { path: "areas/finance/about.md", properties: { owner: "@seyi", delegate: "Grok Bot", modes: ["Manager"] } },
  { path: DAILY, properties: { at: "10am", on: "weekdays", mode: "Manager" }, heading: "Manager loop" },
  { path: MONTHLY, properties: { at: "4pm", paused: "true" }, heading: "Month-end close" },
];

const LISTING: FolderListing = { path: "areas", folderDefault: "team", entries: [entry("folder", "areas/finance")], truncated: false, manifestUsable: true };

beforeEach(() => {
  forgetViews();
  runs.length = 0;
  release = null;
});
afterEach(unmountAll);

describe("Run now", () => {
  test("sends that routine, once, without opening its editor, and the row shows how it went", async () => {
    windowOf(1440);
    await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    const button = one(`area-panel-routine-run-${DAILY}`);
    expect(button.getAttribute("aria-label")).toBe("Run Manager loop now");
    await press(button);
    await press(button);
    expect(runs).toEqual([DAILY]);
    expect(strip(button.textContent)).toBe("Running…");
    expect(all(`area-panel-routine-edit-${DAILY}`)).toHaveLength(0);
    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Its cap was spent: held, as the clock would have held it.
    expect(strip(one(`area-panel-routine-${DAILY}`).textContent)).toContain("Held");
    expect(strip(one(`area-panel-routine-run-${DAILY}`).textContent)).toBe("Run now");
  });

  test("a paused routine has nothing to send", async () => {
    windowOf(1440);
    await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(all(`area-panel-routine-run-${MONTHLY}`)).toHaveLength(0);
  });

  test("a reader has no Run now", async () => {
    windowOf(1440);
    await mount(host(null, { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(all(`area-panel-routine-run-${DAILY}`)).toHaveLength(0);
  });
});
