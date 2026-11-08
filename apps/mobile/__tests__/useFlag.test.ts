/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockAnswer: unknown = undefined;
jest.mock("convex/react", () => ({ useQuery: () => mockAnswer }));
jest.mock("@context/shared/src/flags.cjs", () => ({
  isFlagId: (id: string) => id === "tex.sample" || id === "app.other",
}));

import { useFlag } from "../features/flags/useFlag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `useFlag` reads the person's live set: off while loading, off for an id not in code. */

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe() {
  return createElement("span", null, ["tex.sample", "app.other", "tex.retired"].map((id) => `${id}=${useFlag(id)}`).join(" "));
}

test("on only for the flags in the person's set that are still in code", () => {
  mockAnswer = ["tex.sample", "tex.retired"];
  act(() => root.render(createElement(Probe)));
  expect(container.textContent).toBe("tex.sample=true app.other=false tex.retired=false");
});

test("off for everything while the first answer is on its way", () => {
  mockAnswer = undefined;
  act(() => root.render(createElement(Probe)));
  expect(container.textContent).toBe("tex.sample=false app.other=false tex.retired=false");
});
