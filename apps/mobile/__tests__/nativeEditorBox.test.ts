/**
 * @jest-environment jsdom
 */

/**
 * THE BLANK NOTE EDITOR, PINNED.
 *
 * On a phone, opening a note rendered the collapsed "3 properties" row and the
 * "Saved in your bucket" line with **nothing between them**. The document was
 * not missing, it was zero points tall: `NoteEditor` at compact puts the whole
 * note flow inside one vertical `ScrollView`, and the editor had become a
 * `WebView` styled `flex: 1`. A scroll view's content container has no height
 * of its own — it is defined by what its children measure to — so a `flex: 1`
 * child of it has no free space to grow into and collapses. It worked while the
 * editor was a `TextInput`, which grows to its own content.
 *
 * ## What this file can and cannot claim
 *
 * **jsdom lays nothing out.** No assertion here can measure a rendered height,
 * and a test that pretended to would be worth less than nothing. What is
 * asserted instead is the thing that was actually wrong: the *style the editor
 * asks for*. On a phone it must be a stated height; it must not be the flexed
 * stylesheet, and it must not carry `flex`/`flex-basis` alongside a height,
 * because `flex: 1` sets `flex-basis: 0` and that wins over a `height` on the
 * main axis — a style array carrying both would collapse exactly as before.
 *
 * That is a real, falsifiable claim about this component: put `styles.wrap`
 * back and every test below fails.
 *
 * `webviewHost.test.ts` pins `editorBox` as arithmetic. This file exists
 * because arithmetic in a module nothing reads is how the first version of this
 * bug got shipped: it mounts the **real** `LiveEditor.tsx` and proves the
 * decision reaches the view. react-native-webview has no web build — its
 * platform-less entry renders "React Native WebView does not support this
 * platform" — so the one child under test is stubbed, which is sound here
 * because what is under test is the box around it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ScrollView } from "react-native";
import type { LiveEditorProps } from "../features/console/files/LiveEditor.web";

/*
  The stub. It renders a plain view so the tree is a tree, and answers
  `injectJavaScript` because `LiveEditor` publishes the theme into the guest on
  mount and would otherwise throw before it ever returned a style.
*/
jest.mock("react-native-webview", () => {
  const { createElement: h, forwardRef: fwd, useImperativeHandle: handle } =
    require("react") as typeof import("react");
  const { View: RNView } = require("react-native") as typeof import("react-native");
  return {
    WebView: fwd((_props: Record<string, unknown>, ref: unknown) => {
      handle(ref as never, () => ({ injectJavaScript: () => {}, reload: () => {} }));
      return h(RNView, { testID: "webview-stub" });
    }),
  };
});

/*
  By its explicit path, because this suite resolves `.web.tsx` first — see
  `jest.config.js`. A bare `./LiveEditor` here would mount the browser's
  CodeMirror-in-a-div and go green while the half that shipped blank was never
  loaded, which is precisely the class of false green this project keeps
  producing. The props type is the shared one, declared in the web half.
*/
const { LiveEditor } = require("../features/console/files/LiveEditor.tsx") as {
  LiveEditor: (props: LiveEditorProps) => ReactNode;
};

/* -------------------------------------------------------------------------- */

const LABEL = "1-projects/plan.md markdown";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * The editor, mounted **inside a real `ScrollView`** — which is the whole
 * point. The bug does not exist in isolation; it exists in a scroller, and a
 * test that mounted the editor on its own would be describing a different
 * component from the one that shipped blank.
 */
function mountInScroller(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        ScrollView,
        { testID: "page-scroll" },
        createElement(LiveEditor, {
          value: "# A note\n\nWith a paragraph under it.\n",
          editable: true,
          onChange: () => {},
          onSave: () => {},
          accessibilityLabel: LABEL,
        }),
      ),
    );
  });

  const host = container.querySelector<HTMLElement>(`[aria-label="${LABEL}"]`);
  if (host === null) throw new Error("the editor did not render");
  return { container, host, style: window.getComputedStyle(host) };
}

/* -------------------------------------------------------------------------- */

describe("the editor's box inside the note's page scroller", () => {
  /**
   * THE assertion. Restore `style={styles.wrap}` and this fails.
   */
  test("a phone gives it a stated height, so it has something to be", () => {
    const { style } = mountInScroller(390);

    const height = Number.parseFloat(style.height);
    expect(Number.isFinite(height)).toBe(true);
    expect(height).toBeGreaterThan(0);
  });

  test("and no flex beside it, which would win and collapse it anyway", () => {
    /*
      `flex: 1` is `flex-grow: 1; flex-shrink: 1; flex-basis: 0%`, and a zero
      basis beats a `height` on the main axis. So "it has a height" is only half
      the claim — the other half is that nothing is still asking for a basis of
      nothing. This is the assertion that would have caught a fix applied as a
      style array rather than as a choice between two styles.
    */
    const { style } = mountInScroller(390);

    const basis = style.flexBasis;
    expect(basis === "" || basis === "auto").toBe(true);
    expect(style.flexGrow === "" || style.flexGrow === "0").toBe(true);
  });

  test("the web view is inside that box rather than beside it", () => {
    // A height on a view that does not contain the editor is a spacer.
    const { container, host } = mountInScroller(390);
    const stub = container.querySelector('[data-testid="webview-stub"]');
    expect(stub).not.toBeNull();
    expect(host.contains(stub)).toBe(true);
  });

  test("a pointer layout still flexes, because a region bounds it there", () => {
    /*
      The counterpart, and the reason this is a density choice rather than a
      blanket one: on a tablet the editor fills a region with a real toolbar
      above it, the region has the free space, and a stated height would fight
      it — the note would stop growing with the window.
    */
    const { style } = mountInScroller(1180);

    expect(style.flexGrow).toBe("1");
    // Whatever the region gives it, and nothing of its own.
    expect(style.height === "" || style.height === "auto").toBe(true);
  });
});
