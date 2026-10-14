/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Light, Dark, or follow the device — the person's own choice (Dev2,
 * 2026-10-14: "It can't be based off system settings any longer").
 *
 *  1. **The choice outranks the device**, live, in every hook, and "Device"
 *     hands it back. A surface a provider pins (the landing sign-up) stays
 *     pinned.
 *  2. **It is written where the first paint can read it**: the key the
 *     shell's pre-paint script reads, and `<html data-appearance>`.
 *  3. **It follows the account, and the later change wins**, without ever
 *     sending one person's choice to another person's account.
 *
 * ## Sabotage record
 *
 *   `useScheme` ignores the stored choice                       1
 *   reconcile pushes another account's choice                   1
 *   shell script reads a different key                          1
 */

// The device copy, kept in jsdom's localStorage so the shell's key is checked too.
jest.mock("../features/offline/store", () => ({
  openStore: () => ({
    durable: true,
    get: async (key: string) => globalThis.localStorage.getItem(key),
    set: async (key: string, value: string) => globalThis.localStorage.setItem(key, value),
    remove: async (key: string) => globalThis.localStorage.removeItem(key),
  }),
}));

type Listener = (event: { matches: boolean }) => void;
class FakeQuery {
  matches = false;
  private listeners = new Set<Listener>();
  addListener(listener: Listener) {
    this.listeners.add(listener);
  }
  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }
  addEventListener(_type: string, listener: Listener) {
    this.addListener(listener);
  }
  removeEventListener(_type: string, listener: Listener) {
    this.removeListener(listener);
  }
  switchTo(scheme: "light" | "dark") {
    this.matches = scheme === "dark";
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      act(() => listener({ matches: this.matches }));
    }
  }
}
const query = new FakeQuery();
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => query });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Required after `matchMedia` exists, which `import` would hoist above.
/* eslint-disable @typescript-eslint/no-require-imports */
const theme = require("../features/design/theme") as typeof import("../features/design/theme");
const appearance = require("../features/design/appearance") as typeof import("../features/design/appearance");
/* eslint-enable @typescript-eslint/no-require-imports */

const { ThemeProvider, useScheme } = theme;
const {
  APPEARANCE_KEY,
  appearanceSettledForTests,
  parseStoredAppearance,
  reconcileAppearance,
  resetAppearanceForTests,
  setAppearance,
  startAppearanceSync,
  syncAppearanceWithAccount,
} = appearance;

function mount(node: ReactNode): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

function stored() {
  return parseStoredAppearance(window.localStorage.getItem(APPEARANCE_KEY));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-appearance");
  resetAppearanceForTests();
  query.matches = false;
});

afterEach(() => {
  resetAppearanceForTests();
});

describe("the choice outranks the device", () => {
  test("Dark and Light pin the app, live, and Device hands it back", async () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(useScheme());
      return null;
    }
    const unmount = mount(createElement(Probe));
    try {
      expect(seen.at(-1)).toBe("light");
      await act(() => setAppearance("dark"));
      expect(seen.at(-1)).toBe("dark");
      // The device changing underneath does not move a pinned choice.
      query.switchTo("light");
      expect(seen.at(-1)).toBe("dark");
      await act(() => setAppearance("system"));
      expect(seen.at(-1)).toBe("light");
      query.switchTo("dark");
      expect(seen.at(-1)).toBe("dark");
      await act(() => setAppearance("light"));
      expect(seen.at(-1)).toBe("light");
    } finally {
      unmount();
    }
  });

  test("a provider's own pin still wins over the choice", async () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(useScheme());
      return null;
    }
    await act(() => setAppearance("dark"));
    const unmount = mount(createElement(ThemeProvider, { scheme: "light", children: createElement(Probe) }));
    try {
      expect(seen.at(-1)).toBe("light");
    } finally {
      unmount();
    }
  });

  test("a provider with no pin follows the choice", async () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(useScheme());
      return null;
    }
    const unmount = mount(createElement(ThemeProvider, { children: createElement(Probe) }));
    try {
      await act(() => setAppearance("dark"));
      expect(seen.at(-1)).toBe("dark");
    } finally {
      unmount();
    }
  });
});

describe("written where the first paint can read it", () => {
  test("the device copy and the html attribute", async () => {
    await setAppearance("dark");
    expect(stored()).toMatchObject({ appearance: "dark", pending: true });
    expect(document.documentElement.getAttribute("data-appearance")).toBe("dark");
    await setAppearance("system");
    expect(document.documentElement.hasAttribute("data-appearance")).toBe(false);
  });

  test("the shell's pre-paint script reads the same key and honours both words", () => {
    const shell = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
    const start = shell.indexOf('<script id="context-appearance">');
    expect(start).toBeGreaterThan(-1);
    const script = shell.slice(start, shell.indexOf("</script>", start));
    expect(script).toContain(`localStorage.getItem("${APPEARANCE_KEY}")`);
    // It runs before the body, so the ground is right on the first paint.
    expect(start).toBeLessThan(shell.indexOf("<body"));
    expect(shell).toContain('html[data-appearance="light"]');
    expect(shell).toContain('html[data-appearance="dark"]');
  });

  test("anything unreadable means follow the device", () => {
    expect(parseStoredAppearance(null)).toEqual({ appearance: "system" });
    expect(parseStoredAppearance("{")).toEqual({ appearance: "system" });
    expect(parseStoredAppearance('{"appearance":"sepia"}')).toEqual({ appearance: "system" });
    expect(parseStoredAppearance('{"appearance":"dark","account":"../x"}')).toEqual({ appearance: "dark" });
  });
});

describe("following the account", () => {
  const me = "user_me";

  test("the later change wins, either way", () => {
    expect(
      reconcileAppearance({ appearance: "dark", account: me, changedAt: 20, pending: true }, { appearance: "light", updatedAt: 10 }, me),
    ).toEqual({ kind: "push", appearance: "dark" });
    expect(
      reconcileAppearance({ appearance: "dark", account: me, changedAt: 5, pending: true }, { appearance: "light", updatedAt: 10 }, me),
    ).toEqual({ kind: "adopt", value: { appearance: "light", updatedAt: 10 } });
    expect(
      reconcileAppearance({ appearance: "dark", account: me, changedAt: 5 }, { appearance: "light", updatedAt: 10 }, me),
    ).toEqual({ kind: "adopt", value: { appearance: "light", updatedAt: 10 } });
    expect(reconcileAppearance({ appearance: "light", account: me, changedAt: 10 }, { appearance: "light", updatedAt: 10 }, me)).toEqual({
      kind: "none",
    });
  });

  test("a choice made before sign-in is carried up; following the device needs no row", () => {
    expect(reconcileAppearance({ appearance: "dark", changedAt: 1, pending: true }, null, me)).toEqual({
      kind: "push",
      appearance: "dark",
    });
    expect(reconcileAppearance({ appearance: "system" }, null, me)).toEqual({ kind: "claim" });
  });

  test("another person's choice on this device is never sent to this account", () => {
    const theirs = { appearance: "dark" as const, account: "user_other", changedAt: 99, pending: true };
    expect(reconcileAppearance(theirs, null, me)).toEqual({ kind: "reset" });
    expect(reconcileAppearance(theirs, { appearance: "light", updatedAt: 1 }, me)).toEqual({
      kind: "adopt",
      value: { appearance: "light", updatedAt: 1 },
    });
  });

  test("a pick while signed in reaches the account, and the account's pick reaches the device", async () => {
    const sent: string[] = [];
    const push = async (value: string) => {
      sent.push(value);
      return 1_000;
    };
    const stop = startAppearanceSync(me, push);
    try {
      await syncAppearanceWithAccount(null, me, push);
      await appearanceSettledForTests();
      await setAppearance("dark");
      await appearanceSettledForTests();
      expect(sent).toEqual(["dark"]);
      expect(stored()).toEqual({ appearance: "dark", account: me, changedAt: 1_000 });

      // Picked Light on another device, later.
      await syncAppearanceWithAccount({ appearance: "light", updatedAt: 2_000 }, me, push);
      await appearanceSettledForTests();
      expect(appearance.currentAppearance()).toBe("light");
      expect(sent).toEqual(["dark"]);
    } finally {
      stop();
    }
  });
});
