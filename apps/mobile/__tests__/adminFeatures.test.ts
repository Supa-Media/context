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

import { FeaturesSection } from "../features/admin/FeaturesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Features tab draws the server's list, and a switch sends that feature's key. */

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

test("each feature is a row with its words and a switch that sends its key", async () => {
  mockListed = [{ key: "vaultKeyUse", label: "AIs use vault keys", description: "Lets an AI use a saved key.", on: false, updatedAt: null }];
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.textContent).toContain("AIs use vault keys");
  expect(container.textContent).toContain("Lets an AI use a saved key.");
  const toggle = container.querySelector<HTMLElement>('[data-testid="admin-feature-vaultKeyUse-switch"]');
  expect(toggle).not.toBeNull();
  await act(async () => {
    toggle!.click();
  });
  expect(mockSent).toEqual([{ key: "vaultKeyUse", on: true }]);
});

test("while the list loads nothing is switchable", () => {
  mockListed = undefined;
  act(() => root.render(createElement(FeaturesSection)));
  expect(container.querySelector('[data-testid^="admin-feature-"]')).toBeNull();
});
