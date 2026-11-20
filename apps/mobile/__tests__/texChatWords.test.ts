/**
 * @jest-environment jsdom
 */

/**
 * TEX'S WORDS, ON THE GLASS.
 *
 * `appChatMarkdown.test.ts` proves the blocks; this mounts `TexChatWords` and
 * proves what a person can press. A note link and a note card open the note
 * inside the app through `onOpenNote` and never open a browser tab. Without a
 * handler they fall back to the link's own address. The person's own words are
 * drawn plain: a note link in them is words, not a button.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TexChatWords } from "../features/tex/chat/TexChatWords";

const NOTE = "https://context.lc/note/@supa/1-projects/plan.md";

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

function mount(text: string, mine: boolean, onOpenNote?: ((href: string, path: string) => void) | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexChatWords, { text, mine, onOpenNote })));
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("a note link in Tex's words", () => {
  test("pressing it opens the note inside the app, and no browser tab", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const onOpenNote = jest.fn<(href: string, path: string) => void>();
    const words = mount(`Read [the plan](${NOTE}) now`, false, onOpenNote);

    expect(words.find("tex-notelink")?.textContent).toBe("the plan");
    words.press("tex-notelink");

    expect(onOpenNote).toHaveBeenCalledTimes(1);
    expect(onOpenNote).toHaveBeenCalledWith("/console/@supa?note=1-projects%2Fplan.md", "1-projects/plan.md");
    expect(open).not.toHaveBeenCalled();
  });

  test("a note card opens the same note, and never a browser tab", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const onOpenNote = jest.fn<(href: string, path: string) => void>();
    const words = mount(NOTE, false, onOpenNote);

    expect(words.find("tex-notecard")?.textContent).toContain("Plan");
    expect(words.text()).toContain("1-projects");
    words.press("tex-notecard");

    expect(onOpenNote).toHaveBeenCalledWith("/console/@supa?note=1-projects%2Fplan.md", "1-projects/plan.md");
    expect(open).not.toHaveBeenCalled();
  });

  test("with no handler, pressing a note link opens its own https address in a new tab", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const words = mount(`Read [the plan](${NOTE})`, false, null);

    words.press("tex-notelink");

    expect(open).toHaveBeenCalledWith(NOTE, "_blank", "noopener,noreferrer");
  });
});

describe("what is not a note link", () => {
  test("a note link in the person's own words is plain text, not a button", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const onOpenNote = jest.fn<(href: string, path: string) => void>();
    const words = mount(NOTE, true, onOpenNote);

    expect(words.find("tex-notelink")).toBeNull();
    expect(words.find("tex-notecard")).toBeNull();
    expect(words.text()).toContain(NOTE);
    expect(onOpenNote).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("an https link in the person's words still opens a new tab", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const words = mount("see https://supa.media now", true);

    const link = words.find("tex-notelink");
    expect(link).toBeNull();
    act(() => {
      const anchor = Array.from(document.querySelectorAll<HTMLElement>("[role='link']")).find((node) => node.textContent === "https://supa.media");
      anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(open).toHaveBeenCalledWith("https://supa.media", "_blank", "noopener,noreferrer");
  });
});
