/** @jest-environment jsdom */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createElement } from "react";
import type { ResolvedWebsiteAddress } from "@context/shared";

const mockPush = jest.fn();
const mockRequests: unknown[] = [];
let mockView: ResolvedWebsiteAddress | undefined;

jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("../features/site/useWebsiteAddress", () => ({
  useWebsiteAddress: (request: unknown) => {
    mockRequests.push(request);
    return mockView;
  },
}));
jest.mock("../features/share/ShareScreen", () => ({
  ShareScreen: ({ shortLink }: { shortLink: unknown }) => {
    const react = jest.requireActual<typeof import("react")>("react");
    return react.createElement(
      "div",
      { "data-testid": "legacy" },
      JSON.stringify(shortLink),
    );
  },
}));
jest.mock("../features/site/website/WebsitePage", () => ({
  WebsitePage: ({ view }: { view: ResolvedWebsiteAddress }) => {
    const react = jest.requireActual<typeof import("react")>("react");
    return react.createElement("div", { "data-testid": "website" }, view.kind);
  },
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { HandleSite } from "../features/site/HandleSite";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = "";
  mockRequests.length = 0;
  mockPush.mockClear();
  mockView = undefined;
});

function render(segments: string[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(createElement(HandleSite, { rawHandle: "@Atlas", segments })),
  );
  cleanups.push(() => act(() => root.unmount()));
  return container;
}

describe("a handle website address", () => {
  test("renders a website answer ahead of the legacy short-link shape", () => {
    mockView = {
      kind: "page",
      siteName: "Atlas",
      routePath: "/intake",
      audience: "public",
      title: "Intake",
      description: null,
      markdown: "Hello",
      navigation: [],
    };
    const root = render(["intake"]);

    expect(root.querySelector('[data-testid="website"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="legacy"]')).toBeNull();
    expect(mockRequests.at(-1)).toEqual({
      handle: "atlas",
      routePath: "/intake",
      legacySlug: "intake",
    });
  });

  test("renders the compatibility share only when the server names it", () => {
    mockView = {
      kind: "legacy_short_link",
      handle: "atlas",
      slug: "intake",
    };
    const root = render(["intake"]);
    expect(root.querySelector('[data-testid="legacy"]')?.textContent).toContain(
      '"slug":"intake"',
    );
  });

  test("never offers a nested website path as a legacy slug", () => {
    mockView = { kind: "unavailable", siteName: "Atlas", navigation: [] };
    render(["guides", "start"]);
    expect(mockRequests.at(-1)).toEqual({
      handle: "atlas",
      routePath: "/guides/start",
    });
  });
});
