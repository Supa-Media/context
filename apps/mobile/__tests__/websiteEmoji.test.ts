/**
 * @jest-environment jsdom
 *
 * Emoji on a published page. A standard shortcode is its character; a
 * workspace's own `:name:` is drawn as the picture the page carried, and as its
 * words when it carried none. Code is never touched, and nothing but an
 * inline picture is ever drawn, so a page can never make a visitor's browser
 * fetch an address.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { publishedEmojiNames } from "@context/shared";
import { NoteBody } from "../features/share/NoteBody";
import { emojiPictures } from "../features/share/emojiPictures";
import { parseInline, parseNote } from "../features/share/markdown";

const PARROT = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function render(markdown: string, emoji: Record<string, string> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(NoteBody, { blocks: parseNote(markdown).blocks, look: "site", emoji })));
  return container;
}

describe("reading a shortcode", () => {
  test("a standard one is its character, in the words around it", () => {
    expect(parseInline("shipped :tada: today")).toEqual([{ kind: "text", text: "shipped 🎉 today" }]);
    expect(parseInline(":+1:")).toEqual([{ kind: "text", text: "👍" }]);
  });

  test("any other name is an emoji run, which keeps its words", () => {
    expect(parseInline("go :partyparrot:!")).toEqual([
      { kind: "text", text: "go " },
      { kind: "emoji", name: "partyparrot", text: ":partyparrot:" },
      { kind: "text", text: "!" },
    ]);
  });

  test.each(["at 10:30:45", "`:tada:`", "a:tada:b", "::tada::"])("%j is left as it is", (source) => {
    expect(parseInline(source).some((run) => run.kind === "emoji" || run.text.includes("🎉"))).toBe(false);
  });
});

describe("drawing one", () => {
  test("a workspace emoji the page carried is its picture, named for screen readers", () => {
    const page = render("Ship it :partyparrot: :tada:", { partyparrot: PARROT });
    const picture = page.querySelector('[aria-label=":partyparrot:"]');
    expect(picture).not.toBeNull();
    expect(page.innerHTML).toContain(PARROT);
    expect(page.textContent).toContain("🎉");
    expect(page.textContent).not.toContain(":partyparrot:");
  });

  test("one the page did not carry shows its name", () => {
    const page = render("Ship it :partyparrot:");
    expect(page.textContent).toContain(":partyparrot:");
    expect(page.querySelector("img")).toBeNull();
  });
});

describe("what a page may carry", () => {
  test("only inline pictures of the four types, under emoji names", () => {
    expect(
      emojiPictures({
        partyparrot: PARROT,
        tracker: "https://attacker.example/pixel.gif",
        svg: "data:image/svg+xml;base64,PHN2Zz4=",
        page: "data:text/html;base64,PHNjcmlwdD4=",
        "Upper": PARROT,
        broken: 'data:image/png;base64,iVBOR"onerror=',
      }),
    ).toEqual({ partyparrot: PARROT });
    expect(emojiPictures(null)).toEqual({});
    expect(emojiPictures([PARROT])).toEqual({});
  });

  test("the server reads only names used outside code, once each", () => {
    expect(
      publishedEmojiNames("Hi :parrot: :parrot: :Loud: `:inline:`\n\n```\n:fenced:\n```\n\n:+1: :blob-wave:"),
    ).toEqual(["parrot", "blob-wave"]);
  });
});
