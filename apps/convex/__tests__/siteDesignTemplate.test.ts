/**
 * Layout templates and code-note blocks. The template is where a page's words
 * meet a site's HTML, so the cases that matter most are the ones where words
 * try to become markup.
 */
import { describe, expect, test } from "vitest";
import {
  composeSitePage,
  siteTemplateProblems,
  websiteCodeBlock,
  websiteCodeLanguage,
  websiteCodeName,
  type SitePageData,
} from "@context/shared";

const page = (overrides: Partial<SitePageData> = {}): SitePageData => ({
  siteName: "Supa",
  nav: [
    { title: "Music", link: "/music", current: false },
    { title: "Code", link: "/code", current: true },
  ],
  title: "Super smart people",
  description: "",
  path: "/code",
  contentHtml: "<h1>Super smart people</h1><p>Hi</p>",
  introHtml: "<p>Hi</p>",
  sections: [
    { heading: "Supa Radio", text: "Turn a song into a radio video.", link: "https://radio.supa.test", contentHtml: "<p>Turn a song.</p>" },
    { heading: "Togather", text: "Community.", link: "/togather", contentHtml: "<p>Community.</p>" },
  ],
  ...overrides,
});

describe("layout templates", () => {
  test("supa.media: a frame with a nav loop and a cards layout", () => {
    const html = composeSitePage(
      {
        frame:
          '<header><nav>{ each item in site.nav }<a href="{ item.link }" class="{ item.current }">{ item.title }</a>{ end }</nav><a href="/" class="logo">{ site.name }</a></header><main>{ content }</main>',
        template:
          '<h1 class="headline">{ page.title }</h1><div class="cards">{ each card in page.sections }<a class="card" href="{ card.link }"><h2>{ card.heading }</h2><p>{ card.text }</p></a>{ end }</div>',
      },
      page(),
    );
    expect(html).toBe(
      '<header><nav><a href="/music" class="">Music</a><a href="/code" class="current">Code</a></nav><a href="/" class="logo">Supa</a></header>' +
        '<main><h1 class="headline">Super smart people</h1><div class="cards">' +
        '<a class="card" href="https://radio.supa.test"><h2>Supa Radio</h2><p>Turn a song into a radio video.</p></a>' +
        '<a class="card" href="/togather"><h2>Togather</h2><p>Community.</p></a></div></main>',
    );
  });

  test("no layout: the default frame and the page's own content", () => {
    const html = composeSitePage({ frame: null, template: null }, page());
    expect(html).toContain('<main class="site-main"><h1>Super smart people</h1><p>Hi</p></main>');
    expect(html).toContain('<a class="site-name" href="/">Supa</a>');
  });

  test("words never become markup, in text or in attributes", () => {
    const html = composeSitePage(
      { frame: "<main>{ content }</main>", template: '<h1 title="{ page.title }">{ page.title }</h1>{ each s in page.sections }<a href="{ s.link }">{ s.heading }</a>{ end }' },
      page({
        title: '"><img src=x onerror=alert(1)>',
        sections: [{ heading: "<script>alert(1)</script>", text: "", link: "javascript:alert(1)", contentHtml: "" }],
      }),
    );
    expect(html).toBe(
      '<main><h1 title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</h1>' +
        "<a>&lt;script&gt;alert(1)&lt;/script&gt;</a></main>",
    );
  });

  test("an HTML slot is only filled between tags, never inside an attribute", () => {
    const html = composeSitePage(
      { frame: '<main title="{ content }">{ content }</main>', template: null },
      page({ contentHtml: '<p class="x">Hi</p>' }),
    );
    expect(html).toBe('<main title=""><p class="x">Hi</p></main>');
  });

  test("slot HTML is sanitized too", () => {
    const html = composeSitePage({ frame: null, template: null }, page({ contentHtml: "<p>a</p><script>alert(1)</script><img src=x onerror=alert(1)>" }));
    expect(html).not.toMatch(/<script|onerror/);
  });

  test("marker characters a site writes cannot address a slot", () => {
    const html = composeSitePage(
      { frame: "<main>{ content }</main>", template: "<p>0 { page.title }</p>" },
      page({ title: "0", contentHtml: "<b>slot</b>" }),
    );
    // The digit is the site's own text; no slot was filled.
    expect(html).toBe("<main><p>0 0</p></main>");
  });

  test("problems name what to fix", () => {
    expect(siteTemplateProblems("<main></main>", "frame")).toEqual(["layout.html.md needs { content } where each page goes."]);
    expect(siteTemplateProblems("{ page.colour }", "layout")).toEqual(["{ page.colour } is not a field a layout can use."]);
    expect(siteTemplateProblems("{ each x in page.sections }{ x.heading }", "layout")).toEqual([
      "{ each x in page.sections } has no { end }.",
    ]);
    expect(siteTemplateProblems("{ end }", "layout")).toEqual(["{ end } has no { each … } to close."]);
    expect(siteTemplateProblems("{ each x in site.pages }{ end }", "layout")).toEqual([
      "{ each x in site.pages }: a layout can repeat site.nav or page.sections.",
    ]);
    expect(siteTemplateProblems("{ x.heading }", "layout")).toEqual(["{ x.heading } is not a field a layout can use."]);
    expect(siteTemplateProblems("<p>{ color: red }</p>{ content }", "frame")).toEqual([]);
  });
});

describe("code-note blocks", () => {
  test("names say the language", () => {
    expect(websiteCodeLanguage("website/layout.html.md")).toBe("html");
    expect(websiteCodeLanguage("website/styles.CSS.md")).toBe("css");
    expect(websiteCodeLanguage("website/calc.js.md")).toBe("js");
    expect(websiteCodeLanguage("website/about.md")).toBeNull();
    expect(websiteCodeLanguage("website/html.md")).toBeNull();
    expect(websiteCodeName("website/cards.html.md")).toBe("cards");
  });

  test("one block in the note's language; prose and other blocks around it are notes", () => {
    const note = "The frame.\n\n```html\n<main>{ content }</main>\n```\n\nExample:\n\n```css\n.a{}\n```\n";
    expect(websiteCodeBlock(note, "html")).toEqual({ code: "<main>{ content }</main>" });
    expect(websiteCodeBlock("```javascript\nlet a = 1;\n", "js")).toEqual({ problem: "The ```js block is not closed." });
    expect(websiteCodeBlock("~~~js\nlet a = 1;\n~~~", "js")).toEqual({ code: "let a = 1;" });
  });

  test("none or two is a problem, not a guess", () => {
    expect(websiteCodeBlock("just words", "css")).toEqual({ problem: "A .css.md note holds one ```css block, and this one has none." });
    expect(websiteCodeBlock("```css\na{}\n```\n```css\nb{}\n```", "css")).toEqual({
      problem: "A .css.md note holds one ```css block, and this one has 2.",
    });
  });

  test("a longer fence can hold a shorter one", () => {
    expect(websiteCodeBlock("````html\n<pre>```</pre>\n````", "html")).toEqual({ code: "<pre>```</pre>" });
  });
});
