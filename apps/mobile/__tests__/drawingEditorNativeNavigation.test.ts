/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE NATIVE DRAWING EDITOR'S NAVIGATION GATE, AND THE SIBLING TEN LINES ABOVE
 * THAT ALREADY LEARNED THIS LESSON.
 *
 * `DrawingEditor.tsx` has **two** checks of "is this url the editor page", and
 * until this file they disagreed about what that means.
 *
 * The **message** gate uses `isEditorPageUrl`, and its comment records why it
 * had to stop being loose:
 *
 * > This used to reduce both to an origin and compare those, with `?? origin`
 * > behind it — so a url the regex could not read was treated as ours, which is
 * > fail-open in the one check between an arbitrary page and a splice into
 * > somebody's file. `isEditorPageUrl` compares the whole url and refuses what
 * > it cannot read.
 *
 * The **navigation** gate, in the same component, was
 * `request.url.startsWith(`${origin}${DRAWING_EDITOR_PATH}`)` — while its own
 * comment claims the stricter rule: *"The editor is one page and never
 * navigates. Refusing everything else means a redirect cannot turn this frame
 * into a browser pointed at somebody else's site while wearing the console's
 * chrome."*
 *
 * **"Refusing everything else" and a prefix match are not the same sentence.**
 * A prefix admits every same-origin path that merely *begins* with the editor's
 * — `…/index.html.other`, `…/index.htmlx`, `…/index.html/../../elsewhere` —
 * none of which is the one page the comment says this frame may ever be.
 *
 * ## What is NOT at stake, because it sets the severity
 *
 * **Low, and nothing crosses an origin.** The prefix is built from `origin`, so
 * no foreign host was ever admissible, and `originWhitelist={[origin]}` is a
 * second line behind it. Everything the loose form let through is a path on the
 * console's own origin under a prefix that serves one file — so this is a
 * tightening, of the same kind the openers pass shipped, rather than a hole.
 *
 * What makes it worth closing anyway is that **the strict comparison already
 * exists in this file, is already imported, and is already used by the other
 * gate for a documented reason.** The fix is to call it.
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens |
 * | --- | --- |
 * | the navigation gate back to `startsWith` | **1** |
 * | admit any same-origin url | **2** |
 * | drop `originWhitelist` | **1** |
 * | drop `incognito` | **1** |
 * | point `source` at a hardcoded absolute origin | **2** |
 *
 * The two 2s were predicted as 1s and are the measurement: widening the gate to
 * the whole origin fails both the prefix test and the off-origin one, and
 * hardcoding the origin fails both the `source` assertion and the self-hosting
 * one. Numbers written before a run are guesses.
 *
 * **Every one of them was 0 before this file**, measured rather than assumed:
 * with the gate widened to the whole origin and both `originWhitelist` and
 * `incognito` removed together, the pre-existing suite is 328 suites and 6,212
 * tests, fully green. `drawingEditor.test.ts` mounts the **web** half and reads
 * the iframe's `sandbox` and `src`; nothing had ever mounted the native half or
 * read one of its props.
 */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compressToBase64 } from "@context/drawings";

/** Every prop the host handed the WebView, so the boundary can be read back. */
let mockProps: Record<string, unknown> = {};

jest.mock("react-native-webview", () => {
  const { createElement: h, forwardRef: fwd, useImperativeHandle: handle } =
    require("react") as typeof import("react");
  const { View: RNView } = require("react-native") as typeof import("react-native");
  return {
    WebView: fwd((props: Record<string, unknown>, ref: unknown) => {
      handle(ref as never, () => ({ postMessage: () => {}, injectJavaScript: () => {} }));
      mockProps = props;
      return h(RNView, { testID: "drawing-webview-stub" });
    }),
  };
});

/** By explicit path: a bare import is the web half, which has its own suite. */
const { DrawingEditor } = require("../features/console/files/DrawingEditor.tsx") as {
  DrawingEditor: (props: {
    path: string;
    source: string;
    canEdit: boolean;
    onChange: (next: string) => void;
  }) => ReactNode;
};

const { DRAWING_EDITOR_PATH } =
  require("../features/console/files/drawingBridge") as typeof import("../features/console/files/drawingBridge");

/** jsdom's origin, which is what `consoleOrigin()` reads on this half's web sibling. */
const ORIGIN = "http://localhost";
const EDITOR = `${ORIGIN}${DRAWING_EDITOR_PATH}`;

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
];

function drawingFile(elements: unknown[]): string {
  const payload = compressToBase64(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements,
    }),
  );
  return [
    "---",
    "excalidraw-plugin: parsed",
    "---",
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

const roots: Root[] = [];

beforeEach(() => {
  mockProps = {};
});

afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  document.body.innerHTML = "";
});

function mount(): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(root);
  act(() => {
    root.render(
      createElement(DrawingEditor, {
        path: "1-projects/plan.excalidraw.md",
        source: drawingFile(ELEMENTS),
        canEdit: true,
        onChange: () => {},
      }),
    );
  });
}

/** The navigation decision, as react-native-webview will call it. */
function mayNavigateTo(url: string): boolean {
  const decide = mockProps.onShouldStartLoadWithRequest as
    | ((request: { url: string }) => boolean)
    | undefined;
  if (typeof decide !== "function") {
    throw new Error("the WebView was mounted with no navigation decision at all");
  }
  return decide({ url });
}

describe("the native drawing editor is one page and never navigates", () => {
  test("the page it was asked for is the page it may be", () => {
    mount();

    expect(mockProps.source).toEqual({ uri: EDITOR });
    expect(mayNavigateTo(EDITOR)).toBe(true);
    // A query or fragment is the same document, and the editor page is reached
    // with neither today — but refusing them would break the frame for a
    // redirect that adds one, and `isEditorPageUrl` strips both before
    // comparing precisely so this stays true.
    expect(mayNavigateTo(`${EDITOR}?theme=dark`)).toBe(true);
    expect(mayNavigateTo(`${EDITOR}#scene`)).toBe(true);
  });

  test("AND A PATH THAT MERELY STARTS WITH THE EDITOR'S IS NOT THE EDITOR", () => {
    /*
      The difference between "one page" and "a prefix". Each of these begins
      with the editor's url and is a different document; a `startsWith` admits
      all of them, and the comment above the gate says none of them is allowed.

      Reachable from a drawing, which is the reason to care at all: an
      Excalidraw element carries a `link`, the scene is customer content, and
      following one is a navigation this gate is the only thing deciding.
    */
    mount();

    for (const url of [
      `${EDITOR}x`,
      `${EDITOR}.other`,
      `${EDITOR}/../../console`,
      `${EDITOR}@evil.example`,
      `${EDITOR}\\..\\..\\elsewhere`,
    ]) {
      expect(mayNavigateTo(url)).toBe(false);
    }
  });

  test("and nothing off this origin, nor anything unreadable", () => {
    mount();

    for (const url of [
      "https://evil.example/drawing-assets/editor/index.html",
      `${ORIGIN}/console/@someone/1-projects/plan.md`,
      `${ORIGIN}/`,
      "about:blank",
      "data:text/html,<script>1</script>",
      "javascript:void 0",
      // No scheme-and-host at all: `isEditorPageUrl` refuses what it cannot
      // read rather than comparing loosely, which is the fail-open the message
      // gate in this same file was fixed for.
      "/drawing-assets/editor/index.html",
      "",
    ]) {
      expect(mayNavigateTo(url)).toBe(false);
    }
  });

  test("the realm keeps nothing after the view goes", () => {
    /*
      `incognito` is the prop carrying the promise in the component's own words
      — *"A drawing is the customer's content: nothing about it should outlive
      this view in a shared web store"* — and it is also why the native half of
      `drawingOffline` is deliberately a no-op: turning it off to get HTTP
      caching would start persisting cookies, `localStorage` and IndexedDB for
      the console's origin.
    */
    mount();

    expect(mockProps.incognito).toBe(true);
    expect(mockProps.originWhitelist).toEqual([ORIGIN]);
  });

  test("and the origin is read, never hardcoded", () => {
    // The failure `drawingEditor.test.ts` records for the web half's `src`, in
    // the half it does not cover: an absolute URL to our own domain works
    // perfectly in our deployment and silently points every self-hosted console
    // at ours.
    mount();

    expect(String((mockProps.source as { uri: string }).uri)).toContain(ORIGIN);
    expect(String((mockProps.source as { uri: string }).uri)).not.toContain("context.lc");
  });
});
