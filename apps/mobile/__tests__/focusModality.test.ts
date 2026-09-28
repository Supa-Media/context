/**
 * @jest-environment jsdom
 */

/**
 * The focus ring is for the keyboard. A mouse press focuses too, and a ring
 * left around a row you clicked is the thing `:focus-visible` exists to stop
 * (Dev2, 2026-09-28). The last input decides, as it does in the browser.
 */

import { describe, expect, test } from "@jest/globals";
import { focusFromKeyboard } from "../features/design/focusModality";

describe("focus modality", () => {
  test("a key means keyboard, a press means not", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(focusFromKeyboard()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(focusFromKeyboard()).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(focusFromKeyboard()).toBe(true);
  });
});
