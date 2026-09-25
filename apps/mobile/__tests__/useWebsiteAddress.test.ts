/**
 * @jest-environment jsdom
 *
 * An open website page stays current: when its site's revision moves, or the
 * visitor comes back to the tab, it asks again — and keeps showing the page
 * it has until the new answer arrives, so an edit never blanks the screen.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { ResolvedWebsiteAddress } from "@context/shared";

let mockRevision: string | null | undefined = "1:1";
const mockResolve = jest.fn<(args: unknown) => Promise<ResolvedWebsiteAddress>>();
jest.mock("convex/react", () => ({
  useAction: () => mockResolve,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useQuery: () => mockRevision,
}));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { websites: { resolveAddress: "resolveAddress", siteRevision: "siteRevision" } } },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useWebsiteAddress, type WebsiteAddressRequest } from "../features/site/useWebsiteAddress";

const page = (text: string): ResolvedWebsiteAddress => ({
  kind: "page",
  siteName: "Atlas",
  routePath: "/",
  audience: "public",
  title: "Home",
  description: null,
  markdown: text,
  navigation: [],
});

const seen: (ResolvedWebsiteAddress | undefined)[] = [];
function Probe({ request }: { request: WebsiteAddressRequest }) {
  seen.push(useWebsiteAddress(request));
  return null;
}

let root: Root | null = null;
const request = { handle: "atlas", routePath: "/" };
async function mount() {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe, { request })));
}
async function rerender() {
  await act(async () => root!.render(createElement(Probe, { request: { ...request } })));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen.length = 0;
  mockResolve.mockReset();
  mockRevision = "1:1";
});

describe("an open website page", () => {
  test("asks again when the site's revision moves, without blanking in between", async () => {
    mockResolve.mockResolvedValueOnce(page("Old")).mockResolvedValueOnce(page("New"));
    await mount();
    expect(seen.at(-1)).toMatchObject({ markdown: "Old" });

    seen.length = 0;
    mockRevision = "2:1";
    await rerender();
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(seen).not.toContain(undefined);
    expect(seen.at(-1)).toMatchObject({ markdown: "New" });
  });

  test("an unchanged revision asks nothing more", async () => {
    mockResolve.mockResolvedValue(page("Same"));
    await mount();
    await rerender();
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  test("coming back to the tab asks again", async () => {
    mockResolve.mockResolvedValueOnce(page("Old")).mockResolvedValueOnce(page("Edited elsewhere"));
    await mount();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toMatchObject({ markdown: "Edited elsewhere" });
  });
});
