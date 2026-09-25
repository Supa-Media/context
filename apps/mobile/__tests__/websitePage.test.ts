/**
 * @jest-environment jsdom
 *
 * The public website renderer, in every answer the server can give.
 *
 * What this holds: a page draws its title once and its menu with the current
 * page marked; the members gate follows the server's sign-in path exactly and
 * shows nothing of the page; missing, draft and refused pages are one
 * "Nothing here", and a site that is off offers no way home. And, found while
 * building this: a run of words inside a heading is drawn at the heading's
 * size, not pinned to body size by its own variant.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ResolvedWebsitePage } from "@context/shared";
import { NoteBody } from "../features/share/NoteBody";
import { parseNote } from "../features/share/markdown";
import { WebsitePage, type WebsiteView } from "../features/site/website/WebsitePage";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function render(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

function mount(view: WebsiteView) {
  const navigate = jest.fn();
  const signIn = jest.fn();
  const root = render(createElement(WebsitePage, { name: "Acme", view, navigate, signIn }));
  return { root, navigate, signIn };
}

const page: ResolvedWebsitePage = {
  kind: "page",
  siteName: "Acme",
  routePath: "/about",
  audience: "public",
  title: "About us",
  description: null,
  markdown: "---\naudience: public\n---\n# About us\n\nWe make **plain** things.\n",
  navigation: [
    { routePath: "/", title: "Home" },
    { routePath: "/about", title: "About" },
  ],
};

const byTestId = (root: HTMLElement, id: string) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (element: HTMLElement) => act(() => element.click());

describe("a page", () => {
  test("draws its title once, then its body, and names itself in the tab", () => {
    const { root } = mount(page);
    const text = root.textContent ?? "";
    expect(text.split("About us").length - 1).toBe(1);
    expect(text).toContain("We make plain things.");
    expect(text).not.toContain("audience:");
    expect(document.title).toBe("About us · Acme");
  });

  // jsdom has no layout width, so this is the phone menu: folded until pressed.
  test("the menu is the server's, in its order, with the current page marked", () => {
    const { root, navigate } = mount(page);
    expect(byTestId(root, "site-nav-item")).toHaveLength(0);
    click(byTestId(root, "site-menu")[0]!);
    const items = byTestId(root, "site-nav-item");
    expect(items.map((item) => item.textContent)).toEqual(["Home", "About"]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, "page"]);
    click(items[0]!);
    expect(navigate).toHaveBeenCalledWith("/");
  });
});

describe("the members gate", () => {
  test("follows the server's sign-in path exactly and shows nothing of the page", () => {
    const { root, signIn } = mount({
      kind: "authentication_required",
      siteName: "Acme",
      navigation: [],
      signInPath: "/signin?return=abc",
    });
    expect(root.textContent).toContain("Members only");
    expect(byTestId(root, "site-nav-item")).toHaveLength(0);
    click(byTestId(root, "site-sign-in")[0]!);
    expect(signIn).toHaveBeenCalledWith("/signin?return=abc");
  });
});

describe("nothing here", () => {
  test("an unavailable page is one screen with a way home", () => {
    const { root, navigate } = mount({
      kind: "unavailable",
      siteName: "Acme",
      navigation: [],
    });
    expect(root.textContent).toContain("Nothing here");
    click(byTestId(root, "site-home")[0]!);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  test("a site that is off has no home to offer", () => {
    const { root } = mount({ kind: "off" });
    expect(root.textContent).toContain("Nothing here");
    expect(byTestId(root, "site-home")).toHaveLength(0);
  });
});

describe("a heading's words", () => {
  test("take the heading's size in both looks", () => {
    for (const look of ["note", "site"] as const) {
      const root = render(createElement(NoteBody, { blocks: parseNote("## Plain words").blocks, look }));
      const heading = root.querySelector<HTMLElement>('[role="heading"]')!;
      const run = heading.querySelector<HTMLElement>("span, div")!;
      const size = (el: HTMLElement) => getComputedStyle(el).fontSize;
      expect(size(heading)).not.toBe("");
      // No size of its own, so it inherits the heading's (jsdom does not
      // cascade, so an inheriting run reads as empty here).
      expect(size(run)).toBe("");
    }
  });
});
