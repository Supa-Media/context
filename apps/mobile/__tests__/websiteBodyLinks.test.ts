/**
 * @jest-environment jsdom
 *
 * Links from one website page to another.
 *
 * The server rewrites a link to a published page into that page's address on
 * the site being read — root-relative, `/Public%20Worship`, so a custom-domain
 * visitor stays on the custom domain. The renderer then refused every one of
 * them, because a link with no scheme was only ever a bucket path to a shared
 * note. seyi.co's home page listed four of its own pages in plain text, while
 * the editor drew them as links. These pin the page following them, and the
 * shared-note view still refusing them.
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
import { WebsitePage } from "../features/site/website/WebsitePage";

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

const home = (markdown: string): ResolvedWebsitePage => ({
  kind: "page",
  siteName: "Acme",
  routePath: "/",
  audience: "public",
  title: "Home",
  description: null,
  markdown,
  navigation: [],
});

function mountHome(markdown: string) {
  const navigate = jest.fn();
  const root = render(
    createElement(WebsitePage, { name: "Acme", view: home(markdown), navigate, signIn: jest.fn() }),
  );
  return { root, navigate };
}

// The page's own links: the site name and "Made with Context" are chrome.
const CHROME = new Set(["Acme", "Made with Context"]);
const links = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="link"], a')]
  .filter((el) => !CHROME.has(el.textContent ?? ""));

describe("a link to another page on the same site", () => {
  test("is a link, and following it opens that page", () => {
    const { root, navigate } = mountHome(
      "# Hi\n\n- [Public Worship](/Public%20Worship)\n- [About](/about#team)\n",
    );
    const found = links(root);
    expect(found.map((el) => el.textContent)).toEqual(["Public Worship", "About"]);
    act(() => found[0]!.click());
    expect(navigate).toHaveBeenLastCalledWith("/Public Worship");
    act(() => found[1]!.click());
    expect(navigate).toHaveBeenLastCalledWith("/about");
  });

  test("a protocol-relative or backslashed target is still text", () => {
    const { root } = mountHome("# Hi\n\n[Away](//example.invalid) and [Back](/\\example.invalid)\n");
    expect(links(root)).toHaveLength(0);
    expect(root.textContent).toContain("Away and Back");
  });
});

describe("a shared note", () => {
  test("still draws a root-relative target as its words", () => {
    // A shared note has no site to navigate within; its neighbours are
    // reached through the share's own rules, not a path on this host.
    const root = render(createElement(NoteBody, { blocks: parseNote("[Next](/next)").blocks }));
    expect(links(root)).toHaveLength(0);
    expect(root.textContent).toBe("Next");
  });
});
