/**
 * @jest-environment jsdom
 *
 * `[<kbd>Label</kbd>](target)` is a button, the trick GitHub and Obsidian
 * readers already understand, so a note can carry a call to action that still
 * reads as one outside Context. The target is vetted exactly as a link's is,
 * and a bare `<kbd>` is a key, never a tag this renderer interprets.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NoteBody } from "../features/share/NoteBody";
import { parseInline, parseNote } from "../features/share/markdown";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function render(markdown: string, onSiteLink?: (href: string) => void): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(NoteBody, { blocks: parseNote(markdown).blocks, onSiteLink })));
  return container;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="note-button"]')];

describe("parsing", () => {
  test("a link whose label is one kbd is a button", () => {
    expect(parseInline("[<kbd>Create your workspace</kbd>](/login)")).toEqual([
      { kind: "button", text: "Create your workspace", href: "/login" },
    ]);
    expect(parseInline("[<KBD> GitHub </KBD>](https://github.com)")).toEqual([
      { kind: "button", text: "GitHub", href: "https://github.com" },
    ]);
  });

  test("a refused target is the button's words as text, never a button", () => {
    expect(parseInline("[<kbd>Run</kbd>](javascript:alert(1))")).toEqual([{ kind: "text", text: "Run" }]);
  });

  test("a kbd beside other words in the label is an ordinary link", () => {
    expect(parseInline("[Press <kbd>K</kbd>](https://example.com)")).toEqual([
      { kind: "link", text: "Press <kbd>K</kbd>", href: "https://example.com" },
    ]);
  });

  test("a bare kbd is a key; anything more than words inside stays text", () => {
    expect(parseInline("Press <kbd>⌘K</kbd> to search")).toEqual([
      { kind: "text", text: "Press " },
      { kind: "kbd", text: "⌘K" },
      { kind: "text", text: " to search" },
    ]);
    expect(parseInline("<kbd><b>x</b></kbd>")).toEqual([{ kind: "text", text: "<kbd><b>x</b></kbd>" }]);
  });
});

describe("drawing", () => {
  test("a paragraph of buttons is a row of buttons, and each one follows its target", () => {
    const follow = jest.fn();
    const root = render("[<kbd>Start</kbd>](/login) [<kbd>Pricing</kbd>](/pricing)", follow);
    const found = buttons(root);
    expect(found.map((el) => el.textContent)).toEqual(["Start", "Pricing"]);
    act(() => found[1]!.click());
    expect(follow).toHaveBeenLastCalledWith("/pricing");
  });

  test("a button inside a sentence stays a link", () => {
    const root = render("Read [<kbd>the guide</kbd>](https://example.com) first.", jest.fn());
    expect(buttons(root)).toHaveLength(0);
    expect(root.querySelectorAll('[role="link"]')).toHaveLength(1);
  });

  test("a shared note, with no site to move within, draws a site-path button as its words", () => {
    const root = render("[<kbd>Start</kbd>](/login)");
    expect(buttons(root)).toHaveLength(0);
    expect(root.querySelectorAll('[role="link"]')).toHaveLength(0);
    expect(root.textContent).toBe("Start");
  });

  test("a shared note still draws a button to another site", () => {
    const root = render("[<kbd>GitHub</kbd>](https://github.com/Supa-Media/context)");
    expect(buttons(root).map((el) => el.textContent)).toEqual(["GitHub"]);
  });
});
