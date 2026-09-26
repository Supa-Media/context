/**
 * @jest-environment jsdom
 */

/**
 * A PHONE'S TOASTS WERE UNDER ITS TOOLBAR.
 *
 * The editor region runs full bleed behind the floating chrome on a phone, and
 * the toast host sat `space.x4` from that region's bottom, which is behind the
 * toolbar pill. The toast was drawn and could not be seen, and its Undo could
 * not be reached. The committed auto-organize screenshot harness had been
 * lifting it by hand to photograph it at all.
 *
 * The host now clears the band the frame reports for the toolbar
 * (`contentInsets.bottom`, safe area included) at `compact`, and nothing at a
 * pointer width, where the region really does end above the status strip.
 * Sabotage: drop the lift and the first case fails.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FrameContext, type FrameApi } from "../features/app/appFrame/context";
import { ToastHost } from "../features/design/components/Toast";
import { space } from "../features/design/tokens";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

function inFrame(frame: Partial<FrameApi>): ReactElement {
  return createElement(
    FrameContext.Provider,
    { value: { framed: true, ...frame } as FrameApi },
    createElement(ToastHost, { toasts: [{ id: "t1", message: "Moved to areas." }], onDismiss: () => {} }),
  );
}

const hostBottom = (host: HTMLElement) =>
  getComputedStyle(host.querySelector('[data-testid="toast-host"]') as HTMLElement).bottom;

describe("where the toast host sits", () => {
  test("on a phone, above the floating toolbar", () => {
    const host = mount(inFrame({ density: "compact", contentInsets: { top: 100, bottom: 110 } }));
    expect(hostBottom(host)).toBe(`${110 + space.x4}px`);
  });

  test("at a pointer width, where it always did", () => {
    const host = mount(inFrame({ density: "wide", contentInsets: { top: 0, bottom: 0 } }));
    expect(hostBottom(host)).toBe(`${space.x4}px`);
  });

  test("outside a frame, with nothing to clear", () => {
    const host = mount(createElement(ToastHost, { toasts: [], onDismiss: () => {} }));
    expect(hostBottom(host)).toBe(`${space.x4}px`);
  });
});
