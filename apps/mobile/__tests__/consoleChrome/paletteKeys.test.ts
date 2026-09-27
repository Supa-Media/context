/**
 * @jest-environment jsdom
 */

/**
 * Quick search, driven from the keyboard, in the console itself.
 *
 * `paletteRender/` proves the palette's own list logic. This proves the keys
 * *reach* it where people use it: ⌘O opens it, and ↑, ↓ and Escape pressed in
 * its filter do what they say. They did not, for a month — Enter alone worked,
 * through the filter's own submit, and only ever on the top row —
 * react-native-web's `TextInput` stops every keydown at the React root, the
 * palette listened on `document` in the bubble phase, and the suite dispatched
 * its keys on `document` directly, so nothing noticed.
 *
 * SABOTAGE: drop the `true` from `usePaletteKeys`'s `addEventListener` and
 * both tests below fail.
 */

import { describe, expect, test } from "@jest/globals";
import { mountConsole } from "./fixtures";
import { act } from "react";

function keydown(target: EventTarget, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

function openAndType(app: ReturnType<typeof mountConsole>, query: string) {
  keydown(document.body, { key: "o", ctrlKey: true });
  const input = app.find("palette-input") as HTMLInputElement | null;
  if (input === null) throw new Error("⌘O did not open quick search");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

const selected = () =>
  document.body.querySelector<HTMLElement>('[aria-selected="true"]')?.textContent ?? "";

describe("quick search from the keyboard", () => {
  test("↓ in the filter moves the highlight, ↑ brings it back", () => {
    const app = mountConsole(1440);
    const input = openAndType(app, "proj");
    expect(document.activeElement).toBe(input);
    expect(selected()).toContain("1-projects");

    keydown(input, { key: "ArrowDown" });
    expect(selected()).toContain("See all results");

    keydown(input, { key: "ArrowUp" });
    expect(selected()).toContain("1-projects");
    app.unmount();
  });

  test("Escape in the filter closes it", () => {
    const app = mountConsole(1440);
    const input = openAndType(app, "proj");

    keydown(input, { key: "Escape" });
    expect(app.find("palette-input")).toBeNull();
    app.unmount();
  });
});
