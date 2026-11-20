/**
 * @jest-environment jsdom
 */

/**
 * The canvas's add-step menu (`views/canvas/AddMenu.tsx`), rendered and checked against the artifact's own markup
 * (`fixtures/texLabCanvasGolden.json`, the artifact's `#addMenu` innerHTML at the golden state). The test picker it
 * once sat beside went with the decluttered Lab (mockup W21NekNf2vtnFLXXzAmp7N, 2026-11-16): the canvas shows the
 * test chat's texts instead.
 *
 * The comparison normalises both sides the same way: attributes sorted by name, and `style` values with
 * spaces and trailing semicolons removed, and `:0px` read as `:0` (the CSSOM writes a zero length with its unit,
 * so jsdom and a browser both write `margin: 0px;` where the artifact wrote `margin:0`). Nothing else is normalised.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   `AddMenu` dropping `onPick`'s kind                   "a click on an add-step kind" fails
 *
 * Known drift: the golden's test list is older than `labData.generated.ts`. Four rows exist only in the
 * generated cases (core/q20 and the pipeline replays added since the golden); the
 * golden test removes exactly those and compares the rest.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import golden from "./fixtures/texLabCanvasGolden.json";
import { AddMenu } from "@context/lab/app/views/canvas/AddMenu";
import { allCases } from "@context/lab/app/engine/diff";
import { lab } from "@context/lab/app/engine/state";
import { buildTraces } from "@context/lab/app/engine/traces";

const desktop = golden.desktop;

/** The artifact's markup and React's, compared as the same tree: sorted attributes, style spaces and semicolons dropped. */
function normalise(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  for (const el of Array.from(t.content.querySelectorAll("*"))) {
    const attrs = Array.from(el.attributes).map(
      (a) =>
        [
          a.name,
          a.name === "style"
            ? a.value
                .replace(/\s+/g, "")
                .replace(/;+$/, "")
                .replace(/:0px/g, ":0")
            : a.value,
        ] as const,
    );
    for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
    for (const [n, v] of attrs.sort((x, y) =>
      x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0,
    ))
      el.setAttribute(n, v);
  }
  return t.innerHTML;
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];
afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  while (containers.length > 0) containers.pop()!.remove();
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  lab.ownText = "";
  lab.scn = desktop.scn;
  buildTraces(allCases());
  lab.scn = desktop.scn;
});

describe("the canvas's add-step menu", () => {
  test("renders the artifact's #addMenu markup", () => {
    const container = mount(
      createElement(AddMenu, { onPick: () => undefined }),
    );
    expect(normalise(container.innerHTML)).toBe(normalise(desktop.addMenu));
  });

  test("a click on an add-step kind hands that kind up", () => {
    const onPick = jest.fn();
    const container = mount(createElement(AddMenu, { onPick }));
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-kind="tool"]')!.click(),
    );
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("tool");
  });
});

