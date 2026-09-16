/**
 * @jest-environment jsdom
 */

/**
 * THE PROP THAT WAS ACCEPTED AND DROPPED, PINNED IN THE COMPONENT.
 *
 * `nativePluginSuggest.test.ts` proves the conversation: a host wired to a
 * guest, a line crossing, items coming back, a pick refused on a read-only
 * note. Every one of those tests builds the bridge itself — and that is exactly
 * what the shipped bug would have survived.
 *
 * `LiveEditor.tsx` declared `LiveEditorProps` and destructured neither
 * `onSuggest` nor `onPickSuggestion`. Nothing was broken; nothing was
 * connected. A correct bridge that no component hands its props to is the same
 * blank screen as no bridge at all, and it is the same shape as the blank note
 * editor `nativeEditorBox.test.ts` exists for: arithmetic in a module nothing
 * reads.
 *
 * So this mounts the **real** component and watches what crosses. The one child
 * stubbed is the `WebView` itself — react-native-webview has no web build — and
 * the stub is the interesting part here rather than a formality: it records
 * every `postMessage` the host makes and lets a test post back as the guest, so
 * the assertions are about the wire and not about a mock being called.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { LiveEditorProps } from "../features/console/files/LiveEditor.web";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";

/**
 * Every `postMessage` the host made, and the last `onMessage` handler it
 * installed.
 *
 * `var` and a `mock` prefix because `jest.mock`'s factory is hoisted above
 * every import in this file and may not reference anything else — the two rules
 * together are what let the stub below be a real recording wire rather than a
 * mock somebody asserts was called.
 */
// eslint-disable-next-line no-var
var mockWire: { sent: string[]; deliver: (raw: string) => void } = {
  sent: [],
  deliver: () => {},
};

jest.mock("react-native-webview", () => {
  const { createElement: h, forwardRef: fwd, useImperativeHandle: handle } =
    require("react") as typeof import("react");
  const { View: RNView } = require("react-native") as typeof import("react-native");
  return {
    WebView: fwd((props: { onMessage?: (event: unknown) => void }, ref: unknown) => {
      handle(ref as never, () => ({
        injectJavaScript: () => {},
        reload: () => {},
        postMessage: (raw: string) => mockWire.sent.push(raw),
      }));
      const { onMessage } = props;
      mockWire.deliver = (raw: string) => onMessage?.({ nativeEvent: { data: raw } });
      return h(RNView, { testID: "webview-stub" });
    }),
  };
});

const wire = mockWire;

/*
  By its explicit path: this suite resolves `.web.tsx` first, and a bare
  `./LiveEditor` would mount the browser's editor and go green while the half
  under test was never loaded.
*/
const { LiveEditor } = require("../features/console/files/LiveEditor.tsx") as {
  LiveEditor: (props: LiveEditorProps) => ReactNode;
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  wire.sent.length = 0;
  wire.deliver = () => {};
});

function mount(props: Partial<LiveEditorProps>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(LiveEditor, {
        value: "see --Heb 11:1 now\n",
        editable: true,
        onChange: () => {},
        onSave: () => {},
        accessibilityLabel: "1-projects/plan.md markdown",
        ...props,
      } as LiveEditorProps),
    );
  });
  // Nothing crosses before the guest is listening, so every test needs this.
  act(() => wire.deliver(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" })));
  return {
    types: () => wire.sent.map((raw) => JSON.parse(raw).type as string),
    messages: () => wire.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
  };
}

describe("the editor tells the guest whether a plugin can answer", () => {
  /**
   * THE assertion this file exists for. Delete the `setSuggest` effect from
   * `LiveEditor.tsx` and this fails — and nothing in
   * `nativePluginSuggest.test.ts` does, because that file calls `setSuggest`
   * itself.
   */
  test("a console with a plugin runtime says so", () => {
    const view = mount({ onSuggest: async () => [{ text: "Hebrews 11:1 (KJV)" }] });
    expect(view.messages()).toContainEqual(
      expect.objectContaining({ type: "suggest", available: true }),
    );
  });

  /**
   * The other half of "an absent capability is reported, never faked". A
   * member's console and the landing page's demo have no runtime, and the guest
   * has to be told that rather than left asking into it — which is what makes
   * the ordinary case cost nothing.
   */
  test("a console without one says that instead of staying quiet", () => {
    const view = mount({});
    expect(view.messages()).toContainEqual(
      expect.objectContaining({ type: "suggest", available: false }),
    );
  });
});

describe("an ask from the guest reaches the prop, and the answer goes back", () => {
  test("the line and the caret arrive as the console's callback was given them", async () => {
    const asked: { line: string; ch: number }[] = [];
    const view = mount({
      onSuggest: async (line, ch) => {
        asked.push({ line, ch });
        return [{ text: "Hebrews 11:1 (KJV)" }];
      },
    });

    await act(async () => {
      wire.deliver(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "suggest-ask",
          token: "s1",
          line: "see --Heb 11:1",
          ch: 14,
        }),
      );
      await Promise.resolve();
    });

    expect(asked).toEqual([{ line: "see --Heb 11:1", ch: 14 }]);
    expect(view.messages()).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "suggest-result",
      token: "s1",
      items: [{ text: "Hebrews 11:1 (KJV)" }],
    });
  });

  /**
   * A pick is routed back to whichever plugin offered the list, and the
   * rewritten line comes back out. The component's job is to read the callback
   * off its ref at call time — see the sink in `LiveEditor.tsx` — because
   * `askSuggestions` is rebuilt whenever the set of running sandboxes changes.
   */
  test("a pick reaches the prop and its rewritten line comes back", async () => {
    const picked: number[] = [];
    const view = mount({
      onSuggest: async () => [{ text: "Hebrews 11:1 (KJV)" }],
      onPickSuggestion: async (index) => {
        picked.push(index);
        return "see [[Hebrews 11-1]]";
      },
    });

    await act(async () => {
      wire.deliver(
        JSON.stringify({ v: PROTOCOL_VERSION, type: "suggest-pick", token: "p1", index: 0 }),
      );
      await Promise.resolve();
    });

    expect(picked).toEqual([0]);
    expect(view.messages()).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "suggest-pick-result",
      token: "p1",
      text: "see [[Hebrews 11-1]]",
    });
  });

  /**
   * A request with no reply is a completion that never resolves. The guest is
   * told `available: false` on this surface and should never ask — but it is a
   * separate bundle that can be paired with a host it does not know, so an ask
   * that arrives anyway is answered with the empty list rather than dropped.
   */
  test("an ask on a console with no runtime is answered, not swallowed", async () => {
    const view = mount({});

    await act(async () => {
      wire.deliver(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "suggest-ask",
          token: "s1",
          line: "see --Heb 11:1",
          ch: 14,
        }),
      );
      await Promise.resolve();
    });

    expect(view.messages()).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "suggest-result",
      token: "s1",
      items: [],
    });
  });
});
