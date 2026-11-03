/**
 * @jest-environment jsdom
 *
 * @shared's titles from the workspace objects (`features/console/shared/useSharedWithMe.ts`): the rows wait for the
 * objects' titles, show them over the list's own, and keep the list's own when the ask fails or is slow.
 *
 * Sabotage (temporary local edits, reverted): `withObjectTitles` returning `items` unchanged → "the object's title is
 * shown over the list's own" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
let mockAsks = 0;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useAction: (reference: never) => {
      const name = getFunctionName(reference);
      return () => {
        mockAsks += 1;
        const answer = mockAnswers.get(name);
        if (answer === "never") return new Promise(() => {});
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      };
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TITLE_WAIT_MS, useSharedWithMe } from "../features/console/shared/useSharedWithMe";
import { withObjectTitles, type SharedItem } from "../features/console/shared/sharedInbox";

const LIST = "functions/shares:listSharedWithMe";
const TITLES = "functions/sharedTitles:now";

const share = (entryPath: string, title: string | null): SharedItem => ({
  kind: "share",
  token: `t-${entryPath}`,
  workspaceId: "ws_a",
  slug: "ana",
  displayName: "Ana",
  workspaceKind: "personal",
  entryPath,
  sharedBy: "u_ana",
  sharedByHandle: "ana",
  sharedByName: "Ana",
  title,
  createdAt: 1,
});

let seen: SharedItem[] | undefined | "unset" = "unset";
const unmounts: (() => void)[] = [];

function Probe() {
  seen = useSharedWithMe();
  return null;
}

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  unmounts.push(() => act(() => root.unmount()));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
  mockAnswers.clear();
  mockAsks = 0;
  seen = "unset";
  jest.useRealTimers();
});

describe("@shared's titles from the workspace objects", () => {
  test("the object's title is shown over the list's own, and the rows wait for it", async () => {
    mockAnswers.set(LIST, [share("plan.md", null), share("old.md", "Old")]);
    mockAnswers.set(TITLES, [{ workspaceId: "ws_a", entryPath: "plan.md", title: "Launch week plan" }]);
    mount();
    expect(seen).toBeUndefined();
    await settle();
    expect((seen as SharedItem[]).map((item) => item.title)).toEqual(["Launch week plan", "Old"]);
    expect(mockAsks).toBe(1);
  });

  test("a failed ask keeps the list's own titles", async () => {
    mockAnswers.set(LIST, [share("plan.md", "Plan")]);
    mockAnswers.set(TITLES, new Error("down"));
    mount();
    await settle();
    expect((seen as SharedItem[]).map((item) => item.title)).toEqual(["Plan"]);
  });

  test("a slow ask does not hold the list past the wait", async () => {
    jest.useFakeTimers();
    mockAnswers.set(LIST, [share("plan.md", "Plan")]);
    mockAnswers.set(TITLES, "never");
    mount();
    expect(seen).toBeUndefined();
    act(() => jest.advanceTimersByTime(TITLE_WAIT_MS));
    expect((seen as SharedItem[]).map((item) => item.title)).toEqual(["Plan"]);
  });

  test("titles match a row by its workspace and path, never by path alone", () => {
    const other = { ...share("plan.md", "Theirs"), workspaceId: "ws_b" };
    const merged = withObjectTitles([share("plan.md", null), other], [{ workspaceId: "ws_a", entryPath: "plan.md", title: "Ours" }]);
    expect(merged.map((item) => item.title)).toEqual(["Ours", "Theirs"]);
  });
});
