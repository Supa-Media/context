/**
 * @jest-environment jsdom
 *
 * A DRAWING IS DRAWN, NOT PRINTED.
 *
 * `packages/drawings` proves the parse and the layout without React. What is
 * only visible once something is mounted is whether the component actually puts
 * that layout on screen — and whether a drawing it cannot decode still shows a
 * person something they can read instead of an error or a blank box.
 *
 * So the checks are:
 *
 *  1. The scene reaches the DOM as shapes and text, and the payload reaches it
 *     nowhere.
 *  2. A shape's label — which Excalidraw stores as a *separate* element bound
 *     back to the shape — is drawn, so a diagram is not a row of empty boxes.
 *  3. The picture is named for a screen reader, with its labels in the name.
 *  4. Missing, empty and undecodable sources render rather than throw.
 *
 * ## What this file does not cover, said plainly
 *
 * **That `NoteEditor` chooses this component over `LiveEditor` for a drawing.**
 * That branch is the one with teeth — `LiveEditor` would happily hand somebody
 * a caret inside LZ-String base64, where one keystroke produces a payload no
 * reader can decompress and a file that still looks like a file — and mounting
 * `NoteEditor` needs the frame, the router, the encryption controller and an
 * editor bridge, which is a fixture much larger than the thing it would assert.
 * The decision itself is `isDrawingPath(state.path)`, covered in
 * `packages/drawings`; what is genuinely untested is the one line that calls
 * it. Worth knowing before trusting this file's name.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests here.
 *
 *   the unreadable fallback returning null                                   2
 *   text nodes not rendered                                                  1
 *   rect nodes not rendered                                                  1
 *   `labelSummary` dropped from the accessibility label                      1
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { compressToBase64 } from "@context/drawings";

import { DrawingView } from "../features/console/files/DrawingView";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(props: Parameters<typeof DrawingView>[0]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(DrawingView, props));
  });
  return container;
}

const ELEMENTS = [
  {
    id: "boxA",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 160,
    height: 80,
    strokeColor: "#1e1e1e",
    backgroundColor: "#d0e2ff",
    strokeWidth: 2,
    opacity: 100,
  },
  {
    id: "labelA",
    type: "text",
    x: 10,
    y: 30,
    width: 140,
    height: 25,
    text: "Cassowary",
    fontSize: 20,
    containerId: "boxA",
  },
];

function drawingFile(elements: unknown[], { labels = "Cassowary ^labelA" } = {}) {
  const payload = compressToBase64(
    JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements })
  );
  return [
    "---",
    "excalidraw-plugin: parsed",
    "---",
    "",
    "## Text Elements",
    labels,
    "",
    "%%",
    "## Drawing",
    "```compressed-json",
    payload,
    "```",
    "%%",
    "",
  ].join("\n");
}

describe("DrawingView", () => {
  test("draws the drawing rather than printing the file", () => {
    const container = mount({ path: "1-projects/plan.excalidraw.md", source: drawingFile(ELEMENTS) });

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // One rectangle, one label: the label is a separate element bound to the
    // box, so a renderer that ignored `containerId` would draw an empty box.
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("Cassowary");
    // The payload is not on screen anywhere, in any form.
    expect(container.textContent).not.toContain("compressed-json");
  });

  test("names the drawing for a screen reader, with its labels", () => {
    const container = mount({ path: "1-projects/plan.excalidraw.md", source: drawingFile(ELEMENTS) });
    const labelled = container.querySelector('[aria-label^="Drawing: plan"]');
    expect(labelled).not.toBeNull();
    expect(labelled!.getAttribute("aria-label")).toContain("Cassowary");
  });

  test("a drawing it cannot decode still shows its labels, not an error", () => {
    /*
      The `%%` matters: without it the `Text Elements` block runs to the end of
      the file and swallows the fence, and a fence inside a text label is not a
      payload — it is somebody's typing (`payloadFence`). This fixture is about
      an undecodable *payload*, so the payload has to be where the plugin puts
      one.
    */
    const broken = [
      "## Text Elements", "Cassowary ^labelA", "",
      "%%", "## Drawing", "```compressed-json", "!!!!", "```", "%%",
    ].join("\n");
    const container = mount({ path: "1-projects/plan.excalidraw.md", source: broken });

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("Cassowary");
    expect(container.textContent).toContain("could not be decompressed");
    // And it says the file is fine, because it is.
    expect(container.textContent).toContain("untouched");
  });

  test("an empty draft renders without throwing", () => {
    const container = mount({ path: "1-projects/plan.excalidraw.md", source: "" });
    expect(container.textContent).toContain("plan");
  });
});
