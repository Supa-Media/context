/**
 * @jest-environment jsdom
 *
 * The hook that puts a site's favicon in the tab: it wears the icon while the
 * site is mounted, gives the Context favicon back when it unmounts (the
 * visitor went to the console), and changes it when the handle changes.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { SiteIconAnswer } from "../features/site/siteFavicon";

const mockRead = jest.fn<(args: { handle: string }) => Promise<SiteIconAnswer>>();
jest.mock("convex/react", () => ({ useAction: () => mockRead }));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { websites: { siteIcon: "siteIcon" } } },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetSiteFaviconCache } from "../features/site/siteFavicon";
import { useSiteFavicon } from "../features/site/useSiteFavicon";

function Probe({ handle }: { handle: string | null }) {
  useSiteFavicon(handle);
  return null;
}

let root: Root | null = null;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.head.innerHTML = "";
  resetSiteFaviconCache();
  mockRead.mockReset();
});

async function mount(handle: string | null) {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe, { handle })));
}

function iconHrefs(): string[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).map(
    (link) => link.getAttribute("href") ?? "",
  );
}

describe("useSiteFavicon", () => {
  test("wears the site's icon while mounted and gives the Context one back after", async () => {
    document.head.innerHTML = '<link rel="shortcut icon" href="/favicon.ico">';
    mockRead.mockImplementation(async () => ({ kind: "emoji", emoji: "🪐" }));
    await mount("atlas");
    expect(mockRead).toHaveBeenCalledWith({ handle: "atlas" });
    expect(iconHrefs()).toHaveLength(1);
    expect(iconHrefs()[0]).toMatch(/^data:image\/svg\+xml,/);

    act(() => root!.unmount());
    root = null;
    expect(iconHrefs()).toEqual(["/favicon.ico"]);
  });

  test("a site with no icon leaves the Context favicon alone", async () => {
    document.head.innerHTML = '<link rel="shortcut icon" href="/favicon.ico">';
    mockRead.mockImplementation(async () => null);
    await mount("atlas");
    expect(iconHrefs()).toEqual(["/favicon.ico"]);
  });

  test("no handle asks nothing", async () => {
    await mount(null);
    expect(mockRead).not.toHaveBeenCalled();
  });

  test("moving to another site swaps one icon for the other, never stacking them", async () => {
    document.head.innerHTML = '<link rel="shortcut icon" href="/favicon.ico">';
    mockRead.mockImplementation(async ({ handle }) => ({
      kind: "emoji",
      emoji: handle === "atlas" ? "🪐" : "🌿",
    }));
    await mount("atlas");
    await act(async () => root!.render(createElement(Probe, { handle: "fern" })));
    expect(iconHrefs()).toHaveLength(1);
    expect(decodeURIComponent(iconHrefs()[0]!)).toContain("🌿");
  });
});
