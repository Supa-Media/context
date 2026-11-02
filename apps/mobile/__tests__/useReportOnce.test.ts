/**
 * @jest-environment jsdom
 */

/**
 * `useReportOnce`: an admin report is read, never subscribed to. The census
 * and usage reports read whole tables, and as live queries they re-ran on
 * every write for as long as the admin page was open (Convex invoice, owner
 * 2026-10-30). Sabotage: put `useQuery` back in the hook and the
 * "never subscribes" case fails; drop the AppState listener and the
 * "reads again" case fails.
 */

import { afterEach, expect, jest, test } from "@jest/globals";

const reads: unknown[] = [];
let answer: unknown = { total: 1 };
const listeners: ((state: string) => void)[] = [];

const mockConvex = {
  query: async (_reference: unknown, args: unknown) => {
    reads.push(args);
    return answer;
  },
};

jest.mock("convex/react", () => ({
  useConvex: () => mockConvex,
  useQuery: () => {
    throw new Error("an admin report must not subscribe");
  },
}));

jest.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.push(listener);
      return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
    },
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeFunctionReference } from "convex/server";
import { useReportOnce } from "../features/admin/useReportOnce";

const seen: ({ total: number } | undefined)[] = [];
let root: Root | null = null;

function Probe({ days }: { days: number }) {
  // A fresh reference each render, as `api.functions.admin.x` hands one out.
  seen.push(useReportOnce(makeFunctionReference<"query", { days: number }, { total: number }>("functions/admin:censusReport"), { days }));
  return null;
}

async function render(days: number) {
  if (root === null) root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(createElement(Probe, { days }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  reads.length = 0;
  seen.length = 0;
  listeners.length = 0;
  answer = { total: 1 };
});

test("reads once and never subscribes", async () => {
  await render(30);
  expect(reads).toEqual([{ days: 30 }]);
  expect(seen[0]).toBeUndefined();
  expect(seen[seen.length - 1]).toEqual({ total: 1 });
  // A re-render with the same window does not read again.
  await render(30);
  expect(reads).toHaveLength(1);
});

test("a new window reads again and shows loading, not the old window's answer", async () => {
  await render(30);
  answer = { total: 2 };
  await render(7);
  expect(reads).toEqual([{ days: 30 }, { days: 7 }]);
  expect(seen).toContainEqual(undefined);
  expect(seen[seen.length - 1]).toEqual({ total: 2 });
});

test("reads again when the app comes back to the front", async () => {
  await render(30);
  answer = { total: 3 };
  await act(async () => {
    for (const listener of [...listeners]) listener("background");
  });
  expect(reads).toHaveLength(1);
  await act(async () => {
    for (const listener of [...listeners]) listener("active");
  });
  expect(reads).toHaveLength(2);
  expect(seen[seen.length - 1]).toEqual({ total: 3 });
});
