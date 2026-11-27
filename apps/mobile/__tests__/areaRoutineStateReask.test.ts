/**
 * @jest-environment jsdom
 */
/**
 * AN OPEN BOTS PAGE ASKS AGAIN EVERY MINUTE (`areas/useAreaRoutineState.ts`). Dev, 2026-11-27: Muse checked in and the
 * page still said "Not checking yet", because the state was asked once, when the page opened. A later ask that fails
 * keeps the last answer instead of blanking every bot's health.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../features/agent/useConsoleGrant", () => {
  const mint = async () => ({ accessToken: "t" });
  return { useConsoleGrant: () => mint };
});
jest.mock("convex/react", () => ({ useQuery: () => undefined, useMutation: () => async () => null, useAction: () => async () => null, useConvex: () => ({}) }));
jest.mock("../features/console/ConsoleDataContext", () => {
  const data = { selectedContextId: "ws1", contexts: [{ id: "ws1", slug: "acme" }], demo: false };
  return { useOptionalConsoleData: () => data };
});

import { REASK_MS, useAreaRoutineState } from "../features/console/files/folderPage/areas/useAreaRoutineState";
import type { RoutineStateNow } from "../features/console/files/folderPage/areas/areaRoutines";

type Reply = { status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({ status, json: async () => body });
let answers: (() => Reply)[] = [];
let asked = 0;
const served = (at: number) => () => reply(200, { served: true, week: "2026-W48", routines: [], usage: [], checks: [{ bot: "muse", at }] });
let seen: RoutineStateNow = "loading";
function Probe() {
  seen = useAreaRoutineState(true, "").state;
  return null;
}

let root: Root | null = null;
beforeEach(() => {
  jest.useFakeTimers();
  asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    return (answers.shift() ?? served(0))();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => void (await Promise.resolve()));
};

describe("the routine state on an open page", () => {
  test("is asked again every minute, so a new check-in shows without a reload", async () => {
    answers = [served(0), served(5)];
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(Probe)));
    await flush();
    expect(asked).toBe(1);
    expect(seen !== null && seen !== "loading" ? seen.checks : null).toEqual([{ bot: "muse", at: 0 }]);
    await act(async () => void jest.advanceTimersByTime(REASK_MS));
    await flush();
    expect(asked).toBe(2);
    expect(seen !== null && seen !== "loading" ? seen.checks : null).toEqual([{ bot: "muse", at: 5 }]);
  });

  test("keeps the last answer when a later ask fails", async () => {
    answers = [served(7), () => reply(500, {})];
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(Probe)));
    await flush();
    await act(async () => void jest.advanceTimersByTime(REASK_MS));
    await flush();
    expect(asked).toBe(2);
    expect(seen !== null && seen !== "loading" ? seen.checks : null).toEqual([{ bot: "muse", at: 7 }]);
  });
});
