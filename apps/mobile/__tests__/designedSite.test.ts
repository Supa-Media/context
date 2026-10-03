/** @jest-environment jsdom */

/**
 * A designed site page in the browser: the frame and layout drawn around the
 * page's own words, its stylesheet scoped, links on the site followed in
 * place, and nothing a site wrote able to run.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createElement } from "react";
import type { ResolvedWebsitePage, WebsiteDesign } from "@context/shared";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { DesignedSite } from "../features/site/website/DesignedSite.web";
import { pageSections, sitePathOf } from "../features/site/website/designHtml";
import { parseNote } from "../features/share/markdown";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

const view: Extract<ResolvedWebsitePage, { kind: "page" }> = {
  kind: "page",
  siteName: "Supa",
  routePath: "/code",
  audience: "public",
  title: "Code",
  description: null,
  markdown: "# Super smart people\n\n## Supa Radio\n\nTurn a song into a video.\n\n[Open](https://radio.supa.test)\n\n## Togather\n\nGroups and events.\n\n[More](/togather)\n",
  navigation: [
    { routePath: "/music", title: "Music" },
    { routePath: "/code", title: "Code" },
  ],
};

const design: WebsiteDesign = {
  frame:
    '<header><nav>{ each item in site.nav }<a href="{ item.link }" class="{ item.current }">{ item.title }</a>{ end }</nav><a href="/" class="logo">{ site.name }</a></header><main>{ content }</main>',
  template:
    '<h1 class="headline">{ page.title }</h1><div class="cards">{ each card in page.sections }<a class="card" href="{ card.link }"><h2>{ card.heading }</h2><p>{ card.text }</p></a>{ end }</div><img src=x onerror="window.pwned=1">',
  css: ".ctx-site .card { border-radius: 18px; }",
  fonts: ["https://fonts.googleapis.com/css2?family=Space+Grotesk", "https://evil.test/font.css"],
};

function render(navigate = jest.fn<(path: string) => void>()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(createElement(DesignedSite, { view, design, navigate, hrefFor: (path: string) => `/@supa${path === "/" ? "" : path}` })),
  );
  cleanups.push(() => act(() => root.unmount()));
  return { container, navigate };
}

describe("a designed site page", () => {
  test("draws the frame, the layout and the page's sections inside the scoped container", () => {
    const { container } = render();
    const site = container.querySelector(".ctx-site")!;
    expect(site).not.toBeNull();
    expect(site.querySelector("h1.headline")!.textContent).toBe("Code");
    expect([...site.querySelectorAll(".card h2")].map((h) => h.textContent)).toEqual(["Supa Radio", "Togather"]);
    expect(site.querySelector("nav a.current")!.textContent).toBe("Code");
    expect(container.querySelector("style")!.textContent).toContain(".ctx-site .card { border-radius: 18px; }");
    expect(container.querySelector("style")!.textContent).toContain(".ctx-site {");
  });

  test("the page scrolls itself, from the top of each new page", () => {
    // The app turns the document's own scrolling off, so a site that did not
    // bring a scroller of its own could never be read past the first screen.
    const { container } = render();
    const scroller = container.querySelector<HTMLElement>("[data-testid='site-scroll']")!;
    expect(scroller).not.toBeNull();
    expect(scroller.querySelector(".ctx-site")).not.toBeNull();
    expect(scroller.style.overflowY).toBe("auto");
    expect(scroller.style.height).toBe("100%");
  });

  test("nothing a site wrote runs", () => {
    const { container } = render();
    expect(container.innerHTML).not.toMatch(/onerror|<script/);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  test("links on the site carry their real address and are followed in place", () => {
    const { container, navigate } = render();
    const togather = [...container.querySelectorAll<HTMLAnchorElement>(".card")].find((a) => a.textContent?.includes("Togather"))!;
    expect(togather.getAttribute("href")).toBe("/@supa/togather");
    act(() => togather.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(navigate).toHaveBeenCalledWith("/togather");

    const radio = [...container.querySelectorAll<HTMLAnchorElement>(".card")].find((a) => a.textContent?.includes("Supa Radio"))!;
    expect(radio.getAttribute("href")).toBe("https://radio.supa.test");
    navigate.mockClear();
    act(() => radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(navigate).not.toHaveBeenCalled();
  });

  test("loads only Google Fonts", () => {
    render();
    const links = [...document.head.querySelectorAll("link")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["https://fonts.googleapis.com/css2?family=Space+Grotesk"]);
  });
});

describe("design HTML helpers", () => {
  test("sections split at ## and the intro drops the page's own title", () => {
    const blocks = parseNote("# Title\n\nIntro words.\n\n## One\n\nFirst.\n\n[Go](/one)\n\n## Two\n\nSecond.\n").blocks;
    const pictures = { emoji: {}, images: {} };
    const { introHtml, sections } = pageSections(blocks, pictures);
    expect(introHtml).toBe("<p>Intro words.</p>");
    expect(sections.map(({ heading, text, link }) => ({ heading, text, link }))).toEqual([
      { heading: "One", text: "First.", link: "/one" },
      { heading: "Two", text: "Second.", link: "" },
    ]);
  });

  test("only paths on this site are followed in place", () => {
    expect(sitePathOf("/code", "/")).toBe("/code");
    expect(sitePathOf("about", "/code")).toBe("/about");
    expect(sitePathOf("#site-top", "/")).toBeNull();
    expect(sitePathOf("//evil.test/x", "/")).toBeNull();
    expect(sitePathOf("https://evil.test", "/")).toBeNull();
    expect(sitePathOf("mailto:a@b.test", "/")).toBeNull();
  });
});
