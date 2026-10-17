/**
 * @jest-environment jsdom
 */

/**
 * What counts as the person's own hand on the web (`personInput.ts`, owner
 * 2026-10-17): a trusted keystroke, paste or drop, recently. A script's
 * synthetic event is never a person, and a page run by automation says so.
 *
 * jsdom cannot make a trusted event, so the trusted half is the editor's own
 * keystrokes in a real browser; what is pinned here is that nothing a script
 * can dispatch is mistaken for typing.
 *
 * ## Sabotage record
 *
 *  1. `isTrusted` not checked.              → "a script's keystroke is not typing"
 *  2. `navigator.webdriver` ignored.        → "automation is told apart"
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import {
  drivenByAutomation,
  personIsTyping,
  resetPersonInput,
  watchPersonInput,
} from "../features/console/home/personInput";

afterEach(() => {
  resetPersonInput();
  Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
});

describe("personInput", () => {
  test("a script's keystroke is not typing", () => {
    watchPersonInput();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    document.dispatchEvent(new Event("beforeinput"));
    document.dispatchEvent(new Event("paste"));
    expect(personIsTyping()).toBe(false);
  });

  test("automation is told apart", () => {
    expect(drivenByAutomation()).toBe(false);
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    expect(drivenByAutomation()).toBe(true);
  });
});
