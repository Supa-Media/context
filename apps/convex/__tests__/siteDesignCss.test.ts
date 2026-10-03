/**
 * The website stylesheet sanitizer: every rule scoped under the site, nothing
 * that loads, and nothing that reaches the app around the site.
 */
import { describe, expect, test } from "vitest";
import { sanitizeSiteCss, sanitizeStyleAttribute } from "@context/shared";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const scope = ".ctx-site";
const css = (text: string) =>
  sanitizeSiteCss(text, { scope, image: (name) => (name === "logo.png" ? PNG : null) });

describe("site CSS sanitizer: what survives", () => {
  test("supa.media's sheet: variables, cards and the spinning logo", () => {
    const result = css(`
      :root { --bg: #0D0D0F; --text: #F5F3EE; --accent: #FFD23F; font-family: "Space Grotesk", sans-serif; }
      body { background: var(--bg); color: var(--text); }
      .logo img { transition: transform .6s ease; }
      .logo:hover img { transform: rotate(360deg); }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
      @media (prefers-reduced-motion: reduce) { .logo img { transition: none !important; } }
    `);
    expect(result.css).toBe(
      [
        '.ctx-site { --bg: #0D0D0F; --text: #F5F3EE; --accent: #FFD23F; font-family: "Space Grotesk", sans-serif; }',
        ".ctx-site { background: var(--bg); color: var(--text); }",
        ".ctx-site .logo img { transition: transform .6s ease; }",
        ".ctx-site .logo:hover img { transform: rotate(360deg); }",
        ".ctx-site .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }",
        "@media (prefers-reduced-motion: reduce) { .ctx-site .logo img { transition: none !important; } }",
      ].join("\n"),
    );
  });

  test("html, body and :root name the container", () => {
    expect(css("html body > header { color: red }").css).toBe(".ctx-site > header { color: red; }");
    expect(css("html, body, :root { margin: 0 }").css).toBe(".ctx-site, .ctx-site, .ctx-site { margin: 0; }");
    expect(css("body.dark a { color: red }").css).toBe(".ctx-site body.dark a { color: red; }");
  });

  test("ids match the prefixed ids the HTML sanitizer writes; colours are untouched", () => {
    expect(css("#about { color: #fff }").css).toBe(".ctx-site #site-about { color: #fff; }");
  });

  test("a stored picture becomes its data URL", () => {
    expect(css(".hero { background: url(logo.png) center / cover; }").css).toBe(
      `.ctx-site .hero { background: url("${PNG}") center / cover; }`,
    );
    expect(css('.hero { background-image: url("./logo.png"); }').css).toBe(
      `.ctx-site .hero { background-image: url("${PNG}"); }`,
    );
  });

  test("keyframes and Google Fonts", () => {
    const result = css(`@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap");
      @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`);
    expect(result.fonts).toEqual(["https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap"]);
    expect(result.css).toBe("@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }");
  });

  test("strings are re-escaped so no sheet can close its <style>", () => {
    const result = css('.q::before { content: "</style><script>alert(1)</script>"; }').css;
    expect(result).not.toContain("<");
    expect(result).toContain("\\3c /style");
  });

  test("a nested rule is dropped and its parent's declarations kept", () => {
    expect(css(".a { color: red; .b { color: blue } }").css).toBe(".ctx-site .a { color: red; }");
  });
});

describe("site CSS sanitizer: attacks", () => {
  const attacks: Array<[string, string]> = [
    ["remote url", ".a { background: url(https://evil.test/x.png) }"],
    ["quoted remote url", '.a { background: url("https://evil.test/x.png") }'],
    ["protocol-relative url", ".a { background: url(//evil.test/x.png) }"],
    ["javascript url", ".a { background: url(javascript:alert(1)) }"],
    ["escaped url", ".a { background: u\\72 l(https://evil.test/x.png) }"],
    ["escaped property", ".a { b\\ackground: red }"],
    ["image-set", '.a { background: image-set("https://evil.test/x.png" 1x) }'],
    ["-webkit-image-set", '.a { background: -webkit-image-set("https://evil.test/x.png" 1x) }'],
    ["cross-fade", '.a { background: cross-fade(url(https://evil.test/x.png), red) }'],
    ["element()", ".a { background: element(#x) }"],
    ["paint()", ".a { background: paint(evil) }"],
    ["attr()", '.a::after { content: attr(data-x) }'],
    ["expression", ".a { width: expression(alert(1)) }"],
    ["behavior", ".a { behavior: url(evil.htc) }"],
    ["-moz-binding", ".a { -moz-binding: url(https://evil.test/x.xml#x) }"],
    ["custom property smuggling a url", ".a { --x: url(https://evil.test/x.png); background: var(--x) }"],
    ["@import", "@import url(https://evil.test/x.css); .a { color: red }"],
    ["@import string", "@import 'https://evil.test/x.css';"],
    ["@font-face", "@font-face { font-family: x; src: url(https://evil.test/x.woff2) }"],
    ["@namespace", "@namespace svg url(http://www.w3.org/2000/svg);"],
    ["sibling of the container", "~ .app { display: none }"],
    ["child combinator first", "> * { display: none }"],
    ["nesting selector", "& .x { color: red }"],
    ["brace break-out", ".a { color: red } } .b { color: blue"],
    ["cursor url", ".a { cursor: url(https://evil.test/c.cur), auto }"],
    ["list-style-image", ".a { list-style-image: url(https://evil.test/x.png) }"],
    ["src()", '.a { background: src("https://evil.test/x.png") }'],
  ];

  test.each(attacks)("%s", (_name, sheet) => {
    const result = css(sheet);
    expect(result.css).not.toMatch(/evil\.test|javascript|expression|binding|behavior|@import|@font-face|@namespace|image-set|cross-fade|element\(|paint\(|attr\(|src\(/i);
    expect(result.fonts).toEqual([]);
    for (const line of result.css.split("\n").filter(Boolean)) {
      expect(line.startsWith(".ctx-site") || line.startsWith("@media")).toBe(true);
    }
  });

  test("only Google Fonts stylesheets are imported", () => {
    expect(css("@import url(https://fonts.googleapis.com.evil.test/css2?family=x);").fonts).toEqual([]);
    expect(css("@import url(http://fonts.googleapis.com/css2?family=x);").fonts).toEqual([]);
    expect(css("@import url(https://user@fonts.googleapis.com/css2?family=x);").fonts).toEqual([]);
    expect(css("@import url(https://fonts.googleapis.com/evil);").fonts).toEqual([]);
  });

  test("style attributes", () => {
    expect(sanitizeStyleAttribute("color: red; background: url(https://evil.test)")).toBe("color: red");
    expect(sanitizeStyleAttribute("background: url(https://evil.test)")).toBeNull();
  });

  test("output is bounded", () => {
    expect(css(`.a { color: red; }`.repeat(20_000)).css).toBe("");
  });
});
