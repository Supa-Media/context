/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { contextMenuItems } from "../features/console/contextMenu";
import { ConsoleRail } from "../features/console/ConsoleRail";
import type { ConsoleData } from "../features/console/types";
import type { ConsoleRoute } from "../features/console/nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The right-click menu on a rail context.
 *
 * Two layers, tested at their own levels. The *contents* are a pure function
 * (`contextMenuItems`) — every item must lead to a destination that exists
 * today, because a menu item pointing nowhere is the "undefined" pill again.
 * The *behavior* is mounted for real, because the wiring is exactly the part
 * that silently breaks: react-native-web strips `onContextMenu`, so the
 * listener is attached to the DOM node through a ref (the PR #504 paste
 * lesson), and a refactor that loses the ref loses the feature with every
 * pure test still green.
 */

describe("what the menu offers", () => {
  test("every item is a real destination", () => {
    const items = contextMenuItems("agent");
    expect(items.map((item) => item.key)).toEqual(["open", "settings", "sharing"]);
    expect(items[0].route).toEqual({ kind: "context", slug: "agent", view: "browse" });
    expect(items[1].route).toEqual({ kind: "context", slug: "agent", view: "settings" });
    // Sharing lives in Connections (MembersSection is mounted there), so the
    // item goes where the answer actually is.
    expect(items[2].route).toEqual({ kind: "app", section: "connections" });
  });
});

/** The least ConsoleData the rail needs: its two reads are contexts and loading. */
function railData(): ConsoleData {
  return {
    loading: false,
    contexts: [
      {
        id: "ctx-1",
        slug: "agent",
        displayName: "Agent",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
    ],
  } as unknown as ConsoleData;
}

function mountRail(onNavigate: (route: ConsoleRoute) => void): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(ConsoleRail as never, {
        data: railData(),
        route: { kind: "app", section: "map" },
        mode: "full",
        onNavigate,
        account: null,
      } as never),
    );
  });
  return { host, root };
}

function rightClick(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the menu, mounted for real", () => {
  test("right-click opens it; choosing Settings navigates there and closes it", () => {
    const seen: ConsoleRoute[] = [];
    const { host, root } = mountRail((route) => seen.push(route));
    try {
      const entry = host.querySelector('[aria-label="Open @agent"]');
      expect(entry).not.toBeNull();

      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
      rightClick(entry!);
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();

      click(host.querySelector('[data-testid="context-menu-settings"]')!);
      expect(seen).toEqual([{ kind: "context", slug: "agent", view: "settings" }]);
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Escape closes it without navigating", () => {
    const onNavigate = jest.fn();
    const { host, root } = mountRail(onNavigate as never);
    try {
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("a pointer-down anywhere else closes it", () => {
    const onNavigate = jest.fn();
    const { host, root } = mountRail(onNavigate as never);
    try {
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      act(() => {
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("a plain left click still just opens the context", () => {
    const seen: ConsoleRoute[] = [];
    const { host, root } = mountRail((route) => seen.push(route));
    try {
      click(host.querySelector('[aria-label="Open @agent"]')!);
      expect(seen).toEqual([{ kind: "context", slug: "agent", view: "browse" }]);
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
