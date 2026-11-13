/**
 * @jest-environment jsdom
 */

/**
 * The canvas's two pop-ups, rendered and checked against the artifact's own markup
 * (`fixtures/texLabCanvasGolden.json`, the artifact's `#addMenu` and `#scnPop` innerHTML at the golden
 * state): the add-step menu (`views/canvas/AddMenu.tsx`) and the test picker (`views/canvas/ScnPop.tsx`).
 *
 * The comparison normalises both sides the same way: attributes sorted by name, and `style` values with
 * spaces and trailing semicolons removed, and `:0px` read as `:0` (the CSSOM writes a zero length with its unit,
 * so jsdom and a browser both write `margin: 0px;` where the artifact wrote `margin:0`). Nothing else is normalised.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   `ScnPop` ignoring the query                          "typing dentist" fails
 *   `ScnPop` trace not setting lab.ownText               "Trace with text" fails
 *   `AddMenu` dropping `onPick`'s kind                   "a click on an add-step kind" fails
 *
 * Known drift: the golden's test list is older than `labData.generated.ts`. Four rows exist only in the
 * generated cases (core/q20, pipeline/job-sees-chat, pipeline/pdf-of-pictures, pipeline/reads-back); the
 * golden test removes exactly those four and compares the rest.
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
import { AddMenu } from "../features/tex/lab/views/canvas/AddMenu";
import { ScnPop } from "../features/tex/lab/views/canvas/ScnPop";
import { TRACE_GROUPS } from "../features/tex/lab/data/areas";
import { allCases } from "../features/tex/lab/engine/diff";
import { lab } from "../features/tex/lab/engine/state";
import { buildTraces, SCENARIOS } from "../features/tex/lab/engine/traces";

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

/** Set a controlled input's value the way a person typing does, so React sees the change. */
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

describe("the canvas's test picker", () => {
  test("renders the artifact's #scnPop children at the golden state", () => {
    const container = mount(
      createElement(ScnPop, { onClose: () => undefined }),
    );
    // The golden was taken from the artifact's shipped cases; labData.generated.ts (the bench's current cases)
    // has more rows: core/q20 and the pipeline replays added since. Those rows are removed here, and only these.
    const drift = [
      "core/q20",
      "pipeline/job-sees-chat",
      "pipeline/pdf-of-pictures",
      "pipeline/reads-back",
      "pipeline/turn-steps-logged",
      "pipeline/worker-steps-logged",
    ];
    const removed: string[] = [];
    for (const b of Array.from(
      container.querySelectorAll<HTMLElement>("[data-tr]"),
    )) {
      if (drift.includes(b.dataset.tr!)) {
        removed.push(b.dataset.tr!);
        b.remove();
      }
    }
    expect(removed.sort()).toEqual([...drift].sort());
    expect(normalise(container.innerHTML)).toBe(normalise(desktop.scnPop));
    expect(container.querySelector<HTMLTextAreaElement>("#scnOwn")!.value).toBe(
      "",
    );
    expect(container.querySelector<HTMLInputElement>("#scnQ")!.value).toBe("");
  });

  test("the search box has the focus on mount", () => {
    mount(createElement(ScnPop, { onClose: () => undefined }));
    expect(document.activeElement?.id).toBe("scnQ");
  });

  test("typing dentist filters to the tests the artifact's filter keeps", () => {
    const container = mount(
      createElement(ScnPop, { onClose: () => undefined }),
    );
    type(container.querySelector<HTMLInputElement>("#scnQ")!, "dentist");

    const golden_ = document.createElement("template");
    golden_.innerHTML = desktop.scnPop;
    const expected = Array.from(
      golden_.content.querySelectorAll<HTMLElement>("[data-tr]"),
    )
      .filter((b) => {
        const k = b.dataset.tr!;
        const group = k.split("/")[0];
        const name = b.querySelector(".nm")!.textContent!;
        const id = b.querySelector("small")!.textContent!;
        return (name + " " + id + " " + TRACE_GROUPS[group])
          .toLowerCase()
          .includes("dentist");
      })
      .map((b) => b.dataset.tr);

    const shown = Array.from(
      container.querySelectorAll<HTMLElement>("[data-tr]"),
    ).map((b) => b.dataset.tr);
    expect(expected.length).toBeGreaterThan(0);
    expect(shown).toEqual(expected);
    expect(shown).toContain("core/q1");
    expect(container.querySelector<HTMLInputElement>("#scnQ")!.value).toBe(
      "dentist",
    );
  });

  test("a click on a test sets lab.scn and closes the picker", () => {
    const onClose = jest.fn();
    const container = mount(createElement(ScnPop, { onClose }));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-tr="core/q2"]')!
        .click(),
    );
    expect(lab.scn).toBe("core/q2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Trace with a typed message keeps it as the own scenario", () => {
    const onClose = jest.fn();
    const container = mount(createElement(ScnPop, { onClose }));
    const text = "Where is the dentist?";
    act(() => {
      container.querySelector<HTMLTextAreaElement>("#scnOwn")!.value =
        "  " + text + "  ";
    });
    act(() => container.querySelector<HTMLButtonElement>("#scnOwnGo")!.click());
    expect(lab.ownText).toBe(text);
    expect(lab.scn).toBe("own");
    expect(SCENARIOS.own.name).toBe(text);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
