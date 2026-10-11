/** @jest-environment jsdom */

/**
 * Clicking between a site's pages: a page the menu names is already fetched
 * when the click lands, so it draws without asking; a page not fetched yet
 * keeps the last one on screen instead of a blank; and a Publish (a move of
 * the revision) asks again.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createElement } from "react";
import type { ResolvedWebsiteAddress } from "@context/shared";

let mockRevision: string | null | undefined = "r1";
let mockSignedIn = false;
const mockResolve = jest.fn(async (_args: { handle: string; routePath: string }): Promise<ResolvedWebsiteAddress> => {
  throw new Error("not expected");
});
const mockEdge = jest.fn(async (_args: { handle: string; routePath: string }): Promise<ResolvedWebsiteAddress | null> => null);

jest.mock("convex/react", () => ({
  useAction: () => mockResolve,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: mockSignedIn }),
  useQuery: () => mockRevision,
}));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { websites: { resolveAddress: "resolveAddress", siteRevision: "siteRevision" } } },
}));
jest.mock("../features/site/edgeAddress", () => ({
  fetchEdgeAddress: (args: { handle: string; routePath: string }) => mockEdge(args),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetSiteAnswers } from "../features/site/siteAnswers";
import { useWebsiteAddress } from "../features/site/useWebsiteAddress";

const MENU = ["/", "/about", "/team"];
const page = (routePath: string): ResolvedWebsiteAddress => ({
  kind: "page",
  siteName: "Acme",
  routePath,
  audience: "public",
  title: routePath,
  description: null,
  markdown: `${routePath}\n`,
  navigation: MENU.map((path) => ({ routePath: path, title: path })),
});

const shown: (string | undefined)[] = [];
function Probe({ routePath }: { routePath: string }) {
  const view = useWebsiteAddress({ handle: "acme", routePath });
  shown.push(view?.kind === "page" ? view.routePath : view?.kind);
  return null;
}

let root: Root;
const flush = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
};
async function show(routePath: string) {
  await act(async () => root.render(createElement(Probe, { routePath })));
  await flush();
}

beforeEach(() => {
  resetSiteAnswers();
  shown.length = 0;
  mockRevision = "r1";
  mockSignedIn = false;
  mockEdge.mockReset();
  mockEdge.mockImplementation(async (args) => page(args.routePath));
  mockResolve.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("moving between pages", () => {
  test("the menu's pages are fetched when a page lands, so a click on one asks nothing", async () => {
    await show("/");
    expect(mockEdge.mock.calls.map(([args]) => args.routePath).sort()).toEqual(["/", "/about", "/team"]);
    mockEdge.mockClear();
    shown.length = 0;
    await show("/about");
    expect(shown).not.toContain(undefined);
    expect(shown.at(-1)).toBe("/about");
    expect(mockEdge).not.toHaveBeenCalled();
  });

  test("a page not fetched yet keeps the last page on screen, never a blank", async () => {
    await show("/");
    let release: (view: ResolvedWebsiteAddress) => void = () => {};
    mockEdge.mockImplementation((args) =>
      args.routePath === "/hidden" ? new Promise((resolve) => (release = resolve)) : Promise.resolve(page(args.routePath)),
    );
    shown.length = 0;
    await show("/hidden");
    expect(shown).not.toContain(undefined);
    expect(shown.at(-1)).toBe("/");
    await act(async () => release(page("/hidden")));
    await flush();
    expect(shown.at(-1)).toBe("/hidden");
  });

  test("a move of the revision asks for the open page again and drops what was fetched ahead", async () => {
    await show("/");
    mockEdge.mockClear();
    mockRevision = "r2";
    await show("/");
    expect(mockEdge.mock.calls.map(([args]) => args.routePath)).toContain("/");
    mockEdge.mockClear();
    await show("/about");
    // Fetched again after the move, by the refreshed page's menu.
    expect(shown.at(-1)).toBe("/about");
  });

  test("a signed-in visitor asks Convex, never the router's copy", async () => {
    mockSignedIn = true;
    mockResolve.mockImplementation(async (args) => page(args.routePath));
    await show("/");
    expect(mockEdge).not.toHaveBeenCalled();
    expect(mockResolve.mock.calls.map(([args]) => args.routePath).sort()).toEqual(["/", "/about", "/team"]);
  });
});
