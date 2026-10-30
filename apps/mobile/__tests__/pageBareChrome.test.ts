/**
 * @jest-environment jsdom
 */

/**
 * A page opens as nothing but the page (owner, 2026-10-28, on the Notes back
 * button and the "Moved … to @public-worship" banner over a Tex page: "also
 * can you remove this freakin header what the heck"). The ‹ over a page is the
 * round key alone, with no folder's name beside it on the cover.
 *
 * SABOTAGE: ignoring `bare` in `PhoneBack` fails the first test.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PhoneBack } from "../features/console/home/PhoneBack";
import { phoneBackLevels } from "../features/console/home/phoneBack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

function mount(bare: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  // A page at the top of the workspace: its ‹ goes back to Notes, which a note's ‹ names.
  act(() => root.render(createElement(PhoneBack, { levels: phoneBackLevels("plan.page.md"), onGo: () => {}, bare })));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("the phone's back key over a page", () => {
  test("is the round key alone", () => {
    const shown = mount(true);
    expect(shown.querySelector('[data-testid="phone-back"]')).not.toBeNull();
    expect(shown.textContent).toBe("");
  });

  test("a note's still names where it goes", () => {
    expect(mount(false).textContent).not.toBe("");
  });
});
