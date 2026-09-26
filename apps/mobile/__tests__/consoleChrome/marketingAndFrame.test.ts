/**
 * @jest-environment jsdom
 */

/**
 * The signed-in console carries no marketing chrome, and is mounted in the
 * application frame.
 *
 * Split out of `consoleChrome.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { mockConsoleState, mountConsole } from "./fixtures";

describe("the signed-in console carries no marketing chrome", () => {
  test("the footer is gone", () => {
    const app = mountConsole();
    const text = app.text();

    expect(text).not.toContain("Free. You bring the bucket");
    expect(text).not.toContain("MIT · self-hostable");
    expect(text).not.toContain("self-hostable");

    app.unmount();
  });

  test("the wordmark header is gone", () => {
    // It existed only to hold a Sign out button, which is in the workspace
    // switcher on a pointer layout and the account mark on a phone.
    const app = mountConsole();
    expect(app.text()).not.toContain("Context.lc");
    app.unmount();
  });

  test("signing out is under the workspace's name, not floating above the product", () => {
    /*
      It was `rail-sign-out`, the power glyph at the foot of the rail's account
      block, and before that a button in a marketing header. The rail folded
      into `SwitcherMenu`, so it is a row in the menu under the name already in
      the title bar — which is where every application of this shape puts it,
      and still not above the product.
    */
    const app = mountConsole();
    expect(app.find("rail-sign-out")).toBeNull();

    app.press(app.find("account-switcher"));
    expect(app.find("switcher-sign-out")).not.toBeNull();

    app.unmount();
  });
});

describe("the console is mounted in the application frame", () => {
  test("the frame is there and the explorer is a region of it", () => {
    const app = mountConsole();

    expect(app.find("app-frame")).not.toBeNull();
    // Browse has a tree, so the frame gets an explorer.
    expect(app.find("explorer-tree")).not.toBeNull();
    expect(app.find("explorer-resizer")).not.toBeNull();
    expect(app.find("console-status")).not.toBeNull();

    app.unmount();
  });

  test("nothing above the frame scrolls", () => {
    // The original bug in one assertion: the console inside a page that
    // scrolls, with the tree scrolling again inside it.
    const app = mountConsole();
    let node: HTMLElement | null = app.find("app-frame");
    expect(node).not.toBeNull();

    while (node !== null && node !== document.body) {
      const overflow = window.getComputedStyle(node).getPropertyValue("overflow-y");
      expect(["auto", "scroll"]).not.toContain(overflow);
      node = node.parentElement;
    }

    app.unmount();
  });

  test("a route with no tree gets no explorer column", () => {
    // Map spans every context; there is no single tree that belongs beside it.
    mockConsoleState.pathname = "/console";
    const app = mountConsole();

    expect(app.find("app-frame")).not.toBeNull();
    expect(app.find("explorer-tree")).toBeNull();
    expect(app.find("explorer-resizer")).toBeNull();

    app.unmount();
    mockConsoleState.pathname = "/console/@seyi";
  });
});
