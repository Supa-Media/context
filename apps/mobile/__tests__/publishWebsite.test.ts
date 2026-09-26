/**
 * @jest-environment jsdom
 *
 * Publish on the website folder and in its share dialog. Edits under
 * `website/` wait for it (decided by the owner, 2026-09-26), so the button is
 * the whole control: it is there for whoever the server lets publish and for
 * nobody else, it says Publishing… then Published, and when a page stopped it
 * the one line under it names the page.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockPublish = jest.fn<(args: { workspaceId: string }) => Promise<unknown>>();
jest.mock("convex/react", () => ({ useAction: () => mockPublish }));

let mockView: { state: unknown; failed: boolean; actions?: { enable: () => Promise<void> } };
jest.mock("../features/console/website/useWebsite", () => ({ useWebsite: () => mockView }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  PublishWebsite,
  isWebsiteFolder,
  publishProblem,
} from "../features/console/website/PublishWebsite";

const roots: (() => void)[] = [];
beforeEach(() => {
  mockPublish.mockReset();
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(PublishWebsite, { workspaceId: "w1" })));
  return container;
}

const base = { contractVersion: 1, root: "website", handlePath: "/@acme/" };
const enabled = (canPublish: boolean) => ({ ...base, state: "enabled", enabledAt: 1, canManage: false, canPublish });

const button = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="website-publish"]');
const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("who sees it", () => {
  test("only the website folder has one", () => {
    expect(isWebsiteFolder("website")).toBe(true);
    expect(isWebsiteFolder("website/Legal")).toBe(false);
    expect(isWebsiteFolder("1-projects")).toBe(false);
  });

  test("an owner or editor of a site that is on", () => {
    mockView = { state: enabled(true), failed: false };
    expect(button(mount())?.textContent).toBe("Publish");
  });

  test("not a member, and not while the state is loading", () => {
    mockView = { state: enabled(false), failed: false };
    expect(button(mount())).toBeNull();
    mockView = { state: undefined, failed: false };
    expect(button(mount())).toBeNull();
  });

  test("a site that is off: its owner, whose press turns it on", async () => {
    const enable = jest.fn(async () => {});
    mockView = { state: { ...base, state: "disabled", canManage: true }, failed: false, actions: { enable } };
    const root = mount();
    await press(button(root)!);
    expect(enable).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();

    mockView = { state: { ...base, state: "disabled", canManage: false }, failed: false };
    expect(button(mount())).toBeNull();
  });
});

describe("pressing it", () => {
  test("publishes this workspace, and says so", async () => {
    mockView = { state: enabled(true), failed: false };
    mockPublish.mockResolvedValue({ published: true, problems: [] });
    const root = mount();
    await press(button(root)!);
    expect(mockPublish).toHaveBeenCalledWith({ workspaceId: "w1" });
    expect(button(root)?.textContent).toBe("Published");
    expect(root.textContent).not.toContain(":");
  });

  test("a page that stopped it is named, and nothing else is said", async () => {
    mockView = { state: enabled(true), failed: false };
    mockPublish.mockResolvedValue({
      published: false,
      problems: [
        { path: "website/pricing.md", message: "Website frontmatter is not closed." },
        { path: "website/a.md", message: "Multiple website files claim /a." },
      ],
    });
    const root = mount();
    await press(button(root)!);
    expect(button(root)?.textContent).toBe("Publish");
    expect(root.querySelector('[data-testid="website-publish-problem"]')?.textContent).toBe(
      "pricing.md: Website frontmatter is not closed. (and 1 more)",
    );
  });

  test("the words for a problem", () => {
    expect(publishProblem([])).toBeNull();
    expect(publishProblem([{ path: "website/Legal/terms.md", message: "Nope." }])).toBe("terms.md: Nope.");
  });
});
