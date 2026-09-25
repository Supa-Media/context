/**
 * @jest-environment jsdom
 *
 * Turning the site on may write `website/index.md` on the server, so the
 * switch asks for a tree walk the moment it succeeds — the homepage is in the
 * folder when the person looks, not at the next periodic pass. A failed
 * switch asks for nothing.
 */

import { afterEach, expect, jest, test } from "@jest/globals";

let mockFail = false;
const mockEnable = async () => {
  if (mockFail) throw new Error("refused");
  return {};
};
jest.mock("convex/react", () => ({
  useQueries: () => ({ state: { state: "disabled", canManage: true } }),
  useAction: () => mockEnable,
  useMutation: () => async () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* eslint-disable @typescript-eslint/no-require-imports */
const { act, createElement } = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { useWebsite } =
  require("../features/console/website/useWebsite") as typeof import("../features/console/website/useWebsite");
const { onMirrorRefreshRequest } =
  require("../features/offline/mirrorEvents") as typeof import("../features/offline/mirrorEvents");
/* eslint-enable @typescript-eslint/no-require-imports */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  mockFail = false;
});

function actions() {
  let view: ReturnType<typeof useWebsite> | null = null;
  const Probe = () => {
    view = useWebsite("ws_one");
    return null;
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  return view!.actions!;
}

function refreshes(): string[] {
  const asked: string[] = [];
  cleanups.push(onMirrorRefreshRequest((id) => asked.push(id)));
  return asked;
}

test("turning the site on walks that workspace's tree", async () => {
  const asked = refreshes();
  await actions().enable();
  expect(asked).toEqual(["ws_one"]);
});

test("a refused switch asks for no walk", async () => {
  mockFail = true;
  const asked = refreshes();
  await expect(actions().enable()).rejects.toThrow("refused");
  expect(asked).toEqual([]);
});
