/**
 * @jest-environment jsdom
 */

/**
 * A folder's tags on its phone page (board 14: "Tags show on the folder and
 * as a filter on Home"): drawn under the counts, each pressable to go Home
 * filtered to it.
 *
 * SABOTAGE: drop the tag row from `PhoneFolderHead` and "draws the folder's
 * tags" fails; drop its `onTag` and "a tag opens Home filtered to it" fails.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PhoneFolderHead } from "../features/console/home/PhoneFolderHead";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function mount(tags: string[] | undefined, onTag?: (tag: string) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(PhoneFolderHead, {
        folder: "clients",
        counts: { notes: 3, folders: 1 },
        entries: [],
        onOpen: () => {},
        ...(tags === undefined ? {} : { tags }),
        ...(onTag === undefined ? {} : { onTag }),
      }),
    ),
  );
  return container;
}

describe("a folder's tags on its page", () => {
  test("draws the folder's tags, and nothing when it has none", () => {
    const page = mount(["client", "retainer"]);
    expect([...page.querySelectorAll('[data-testid="phone-folder-tag"]')].map((tag) => tag.textContent)).toEqual([
      "client",
      "retainer",
    ]);
    expect(mount([]).querySelector('[data-testid="phone-folder-tags"]')).toBeNull();
    expect(mount(undefined).querySelector('[data-testid="phone-folder-tags"]')).toBeNull();
  });

  test("a tag opens Home filtered to it", () => {
    const opened: string[] = [];
    const page = mount(["client"], (tag) => opened.push(tag));
    const tag = page.querySelector<HTMLElement>('[aria-label="Tagged client. Show on Home"]')!;
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) tag.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    });
    expect(opened).toEqual(["client"]);
  });
});
