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
import { DRAWING_CHANNEL, DRAWING_EDITOR_PATH } from "../features/console/files/drawingBridge";

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

describe("only the frame we loaded may drive a save", () => {
  /*
    THE ORIGIN CHECK IS NOT AN IDENTITY CHECK.

    `readFromEditor` compares `event.origin` against `window.location.origin`,
    which is exactly right for keeping another site out and says nothing about
    *which* same-origin window sent the message. The editor page is served from
    our own origin, so every other same-origin window — the console's own, any
    other frame it ever embeds, anything a `window.open` left behind — clears
    that bar and reaches the branch that splices elements into somebody's file.

    The frame is a `ref` the component already holds, so the identity is free:
    a message that is not from `frame.current.contentWindow` is not from the
    editor. Belt to the sandbox's braces rather than a replacement for it.
  */
  function post(source: Window | null, elements: unknown[]): void {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: DRAWING_CHANNEL, type: "change", elements },
          origin: window.location.origin,
          source,
        }),
      );
    });
  }

  const CHANGED = [{ ...ELEMENTS[0], width: 999 }];

  test("a same-origin message from anywhere else is not a save", () => {
    const saved: string[] = [];
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: true,
      onChange: (next) => saved.push(next),
    });
    expect(container.querySelector("iframe")).not.toBeNull();

    // The console's own window, which passes the origin check every time.
    post(window, CHANGED);
    expect(saved).toEqual([]);
  });

  test("…and the message from the frame itself is", () => {
    // The positive control. Without it the check above passes on a component
    // that ignores every message, including the real ones.
    const saved: string[] = [];
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: true,
      onChange: (next) => saved.push(next),
    });

    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    post(frame.contentWindow, CHANGED);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain("keep-me: yes");
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

describe("what the room sends while the page is still loading", () => {
  /*
    THE BUG TWO BROWSERS FOUND, AND FOUR GREEN SUITES DID NOT.

    The editor is a 2.4MB page fetched on demand; the socket is open long
    before it has booted. The room replays its log the instant a socket opens —
    which on a canvas is the whole drawing everybody else can already see — and
    a `postMessage` into a frame with no listener yet is *gone*, not queued.

    The symptom was exact and unmistakable in a browser and invisible
    everywhere else: a second person opens a shared canvas and finds it blank,
    then it fills in the moment somebody draws something new.
  */
  function ready(container: HTMLElement): void {
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: DRAWING_CHANNEL, type: "ready" },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
    });
  }

  function collaboration(deliver: { remote?: (elements: unknown[]) => void }) {
    return {
      share: () => {},
      point: () => {},
      compact: () => {},
      onRemoteElements: (handler: (elements: unknown[]) => void) => {
        deliver.remote = handler;
        return () => {
          deliver.remote = undefined;
        };
      },
      onPeers: () => () => {},
      onCompactRequest: () => () => {},
    };
  }

  test("elements that arrive before the page is listening are held, then delivered", () => {
    const deliver: { remote?: (elements: unknown[]) => void } = {};
    const posted: unknown[] = [];
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: true,
      onChange: () => {},
      collaboration: collaboration(deliver),
    });
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    // jsdom gives an iframe a real `contentWindow`; spying on it is how "was
    // this posted, and when" becomes a fact rather than an assumption.
    const target = frame.contentWindow as Window;
    target.postMessage = ((message: unknown) => {
      posted.push(message);
    }) as Window["postMessage"];

    // The room's replay, arriving while the page is still fetching.
    act(() => deliver.remote?.([{ id: "fromPeer", type: "rectangle", version: 1 }]));
    expect(posted).toEqual([]);

    ready(container);

    const remote = posted.filter(
      (one) => (one as { type?: string }).type === "remote",
    ) as { elements: { id: string }[] }[];
    expect(remote).toHaveLength(1);
    expect(remote[0].elements.map((one) => one.id)).toEqual(["fromPeer"]);
    // And the `load` went first, so the page has a scene to reconcile into.
    expect((posted[0] as { type?: string }).type).toBe("load");
  });

  test("a canvas nobody shares is told it is not collaborating", () => {
    // `isCollaborating` decides whether undo reverts this person's own work or
    // the last thing that happened to the document. A drawing opened alone must
    // get the ordinary undo.
    const posted: unknown[] = [];
    const container = mount({
      path: PATH,
      source: drawingFile(ELEMENTS),
      canEdit: true,
      onChange: () => {},
    });
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    (frame.contentWindow as Window).postMessage = ((message: unknown) => {
      posted.push(message);
    }) as Window["postMessage"];

    ready(container);
    const load = posted.find((one) => (one as { type?: string }).type === "load");
    expect((load as { collaborating: boolean }).collaborating).toBe(false);
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
