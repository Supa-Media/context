/**
 * @jest-environment jsdom
 *
 * THE EDITOR IS A PAGE, AND IT IS OFFERED ONLY WHEN A SAVE WOULD LAND.
 *
 * Two things are only visible from here.
 *
 * **The console's bundle does not contain Excalidraw.** That is the whole
 * reason the editor is a separate page loaded in an iframe, and it began as a
 * wrong assumption: the first version imported `@excalidraw/excalidraw` behind
 * a dynamic `import()`, which is *not* a lazy chunk under Expo's Metro — the
 * built web bundle went from 5.7MB to 14.6MB, loaded eagerly by a `<script>`
 * tag in `index.html`. A unit test cannot measure a bundle, but it can assert
 * the property that made it true: nothing in the console's import graph reaches
 * the package.
 *
 * **The decision in front of the editor.** This component chooses between a
 * canvas and a read-only view, and choosing wrong hands somebody either a
 * canvas whose saves silently vanish or a refusal to draw on a good file.
 *
 * The bridge's own rules — origin checks, shape checks — are in
 * `drawingBridge.test.ts`, because they are the security-relevant half and
 * belong where they can be read on their own.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests here.
 *
 *   splicability not checked before the iframe is rendered                   2
 *   the iframe's sandbox widened to popups, downloads and navigation         1
 *   the iframe's src made an absolute URL to our own domain                  1
 *
 * The third row is the one that would survive review: an absolute URL works
 * perfectly in our deployment and silently points every self-hosted console at
 * ours, which is the failure `shareOrigin.web.ts` already records for links.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { compressToBase64, parseDrawing, serializeDrawing } from "@context/drawings";

import { DrawingEditor } from "../features/console/files/DrawingEditor.web";
import { DRAWING_EDITOR_PATH } from "../features/console/files/drawingBridge";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(props: Parameters<typeof DrawingEditor>[0]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(DrawingEditor, props));
  });
  return container;
}

const ELEMENTS = [
  { id: "boxA", type: "rectangle", x: 0, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", backgroundColor: "#d0e2ff", strokeWidth: 2, opacity: 100 },
  { id: "labelA", type: "text", x: 10, y: 30, width: 140, height: 25, text: "Cassowary", fontSize: 20, containerId: "boxA" },
];

function drawingFile(elements: unknown[]) {
  const payload = compressToBase64(
    JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements })
  );
  return [
    "---",
    "excalidraw-plugin: parsed",
    "keep-me: yes",
    "---",
    "",
    "## Text Elements",
    "Cassowary ^labelA",
    "",
    "## Element Links",
    "boxA: [[2-areas/apps/context/storage]]",
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

const PATH = "1-projects/plan.excalidraw.md";

describe("the editor never enters the console's bundle", () => {
  test("nothing in the console's import graph loads @excalidraw/excalidraw", () => {
    /*
      This file has imported the component and, in the tests below, rendered
      both of its branches. If any of that reached the package — a static
      import, or a dynamic one Metro would hoist into the eager chunk — it
      would be in the registry by now. The iframe fetches it in a browser
      instead, where no bundler is involved at all.
    */
    mount({ path: PATH, source: drawingFile(ELEMENTS), canEdit: true, onChange: () => {} });

    const loaded = Object.keys(require.cache).some((key) => key.includes("@excalidraw"));
    expect(loaded).toBe(false);
  });

  test("the canvas is an iframe pointed at our own origin", () => {
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: true,
      onChange: () => {},
    });

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    // Root-relative: a self-hosted console serves its own editor, and no
    // deployment reaches back to ours.
    expect(frame!.getAttribute("src")).toBe(DRAWING_EDITOR_PATH);
    expect(frame!.getAttribute("src")?.startsWith("http")).toBe(false);

    // Scripts and same-origin, because the page is ours and runs React. Not
    // navigation, forms, popups or downloads — the editor must not be able to
    // take the console somewhere else or write a file to the customer's
    // machine.
    const sandbox = frame!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-downloads");
    expect(sandbox).not.toContain("allow-forms");
  });
});

describe("the editor is offered only when a save would land", () => {
  test("a drawing that cannot be spliced gets the view and a reason", () => {
    const broken = ["## Text Elements", "Cassowary ^labelA", "", "```compressed-json", "!!!!", "```"].join("\n");
    const container = mount({ path: PATH, source: broken, canEdit: true, onChange: () => {} });

    expect(container.querySelector("iframe")).toBeNull();
    // Still readable — refusing to edit is not refusing to open.
    expect(container.textContent).toContain("Cassowary");
    expect(container.textContent).toContain("could not be read");
    expect(container.textContent).toContain("untouched");
  });

  test("a file with no payload at all is not editable", () => {
    const container = mount({
      path: PATH,
      source: "## Text Elements\n\nCassowary ^labelA\n",
      canEdit: true,
      onChange: () => {},
    });
    expect(container.querySelector("iframe")).toBeNull();
  });

  /*
    A reader still gets the iframe, and that is a decision rather than an
    oversight: the page is told `editable: false` and renders Excalidraw in view
    mode, which pans and zooms a real drawing far better than a static SVG. What
    protects the file is that the console never writes what a page sends unless
    it can splice it — and `canEdit` is enforced by the gateway on the write,
    not by hiding a canvas.
  */
  test("a reader still gets a canvas", () => {
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: false,
      onChange: () => {},
    });
    expect(container.querySelector("iframe")).not.toBeNull();
  });
});

describe("a save is a splice of the file, never a new file", () => {
  test("the serializer keeps what the canvas knows nothing about", () => {
    const original = drawingFile(ELEMENTS);
    const next = serializeDrawing(original, [
      ...ELEMENTS,
      { id: "new", type: "text", x: 0, y: 200, width: 100, height: 25, text: "Quoll", fontSize: 20 },
    ]);

    expect(next).not.toBeNull();
    expect(next).toContain("keep-me: yes");
    expect(next).toContain("boxA: [[2-areas/apps/context/storage]]");
    expect(parseDrawing(next!, PATH).elements).toHaveLength(3);
  });
});
