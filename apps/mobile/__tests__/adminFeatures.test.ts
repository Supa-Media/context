/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockSent: unknown[] = [];
let mockListed: unknown = undefined;
jest.mock("convex/react", () => ({
  useQuery: () => mockListed,
  useMutation: () => async (args: unknown) => void mockSent.push(args),
}));

import { FeaturesSection, expiryLine } from "../features/admin/FeaturesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Features tab draws the server's flags with their expiry, and each control sends that flag's id. */

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockSent.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const LISTED = {
  today: "2026-11-08",
  flags: [
    {
      id: "tex.sample",
      label: "Sample feature",
      description: "A flag for this test.",
      added: "2026-11-01",
      expires: "2026-11-15",
      daysLeft: 7,
      due: true,
      mode: "people",
      updatedAt: null,
      people: [{ userId: "u1", name: "@ada" }],
      groups: [],
    },
  ],
  groups: [{ groupId: "g1", name: "Dogfood", people: [{ userId: "u2", name: "@bo" }] }],
  retired: [{ id: "tex.gone", rows: 2 }],
};

const click = async (id: string) => {
  const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(el).not.toBeNull();
  await act(async () => el!.click());
};

test("each flag shows its words, expiry and testers, and its controls send its id", async () => {
  mockListed = LISTED;
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.textContent).toContain("Sample feature");
  expect(container.textContent).toContain("Expires Nov 15, 2026, in 7 days");
  expect(container.textContent).toContain("@ada");
  await click("admin-flag-tex.sample-everyone");
  // The field opens only on "+ Add", and offers the groups the flag does not have yet.
  expect(container.querySelector('[data-testid="admin-flag-tex.sample-list-field"]')).toBeNull();
  await click("admin-flag-tex.sample-list-open");
  expect(container.querySelector('[data-testid="admin-flag-tex.sample-list-field"]')).not.toBeNull();
  await click("admin-flag-tex.sample-list-pick-Dogfood");
  await click("admin-flag-tex.sample-list-remove-@ada");
  await click("admin-flag-retired-tex.gone-clear");
  expect(mockSent).toEqual([
    { flagId: "tex.sample", mode: "everyone" },
    { flagId: "tex.sample", groupId: "g1" },
    { flagId: "tex.sample", userId: "u1" },
    { flagId: "tex.gone" },
  ]);
});

test("with no flags in code, the tab says where one is added", () => {
  mockListed = { ...LISTED, flags: [], retired: [] };
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.querySelector('[data-testid="admin-flags-empty"]')).not.toBeNull();
  expect(container.textContent).toContain("Dogfood");
});

test("with no groups, the groups section is one line, and its field opens only on + New group", async () => {
  mockListed = { ...LISTED, groups: [] };
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.querySelector('[data-testid="admin-groups-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="admin-group-create-field"]')).toBeNull();
  await click("admin-group-create-open");
  expect(container.querySelector('[data-testid="admin-group-create-field"]')).not.toBeNull();
});

test("on for everyone, the testers are counted and kept rather than listed", () => {
  mockListed = { ...LISTED, flags: [{ ...LISTED.flags[0], mode: "everyone" }] };
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.textContent).toContain("On for everyone. Its testers, 1 person, are kept for if you switch back.");
  expect(container.querySelector('[data-testid="admin-flag-tex.sample-list"]')).toBeNull();
});

test("while the list loads nothing is clickable", () => {
  mockListed = undefined;
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.querySelector('[data-testid^="admin-flag-"]')).toBeNull();
});

test("the expiry line counts down, then says what to do", () => {
  expect(expiryLine(2, "2026-11-10")).toBe("Expires Nov 10, 2026, in 2 days");
  expect(expiryLine(1, "2026-11-09")).toBe("Expires tomorrow, Nov 9, 2026");
  expect(expiryLine(0, "2026-11-08")).toBe("Expires today, Nov 8, 2026");
  expect(expiryLine(-3, "2026-11-05")).toBe("Expired 3 days ago, Nov 5, 2026: launch it or remove it");
});
