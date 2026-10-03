/**
 * The site sanitizers say what they leave out, so an agent building a site can
 * be told why a layout came out empty instead of simplifying it until it
 * renders. Reporting is a side channel: it must never change the output.
 */
import { describe, expect, test } from "vitest";
import { sanitizeSiteCss, sanitizeSiteHtml, type SiteRemoval } from "@context/shared";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const image = (name: string) => (name === "logo.png" ? PNG : null);

function html(input: string): SiteRemoval[] {
  const removals: SiteRemoval[] = [];
  const reported = sanitizeSiteHtml(input, { image, removed: (removal) => removals.push(removal) });
  expect(reported).toEqual(sanitizeSiteHtml(input, { image }));
  return removals;
}

function css(input: string): SiteRemoval[] {
  const removals: SiteRemoval[] = [];
  const options = { scope: ".ctx-site", image };
  const reported = sanitizeSiteCss(input, { ...options, removed: (removal) => removals.push(removal) });
  expect(reported).toEqual(sanitizeSiteCss(input, options));
  return removals;
}

describe("the HTML sanitizer reports what it removes", () => {
  test("clean HTML reports nothing", () => {
    expect(
      html('<header class="top"><a href="/music" target="_blank">Music</a><img src="logo.png" alt=""></header><main>{ content }</main><style>p{}</style><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'),
    ).toEqual([]);
  });

  test("an element dropped with its content is named, with where it starts", () => {
    const input = '<p>a</p>\n<template><main>{ content }</main></template>';
    const [removal, ...rest] = html(input);
    expect(rest).toEqual([]);
    expect(removal).toMatchObject({ what: "<template> and everything inside it", at: input.indexOf("<template>") });
    expect(removal!.why).toMatch(/never drawn/);
    expect(html("<script>alert(1)</script>")[0]!.why).toMatch(/scripts never run/);
    expect(html('<svg viewBox="0 0 1 1"><path d="M0"/></svg>')[0]!.what).toBe("<svg> and everything inside it");
  });

  test("an unknown element is named and its text is said to be kept", () => {
    expect(html("<form><p>x</p></form>")).toEqual([
      { what: "<form>", why: "not an element a site can use; the text inside it is kept", at: 0 },
    ]);
  });

  test("attributes: an event handler, a refused link, a remote and a missing picture", () => {
    const removals = html(
      '<div onclick="x()"><a href="javascript:alert(1)">a</a><img src="https://cdn.test/a.png"><img src="./nope.png"></div>',
    );
    expect(removals.map((removal) => removal.what)).toEqual([
      "onclick on <div>",
      'href="javascript:alert(1)" on <a>',
      'src="https://cdn.test/a.png" on <img>',
      'src="./nope.png" on <img>',
    ]);
    expect(removals[0]!.why).toMatch(/event handlers/);
    expect(removals[2]!.why).toMatch(/only from this workspace/);
    expect(removals[3]!.why).toBe('no picture called "nope.png" is stored in this workspace, under that exact name');
  });

  test("a stylesheet link that is not Google Fonts is reported, a font link is not", () => {
    expect(html('<link rel="stylesheet" href="https://cdn.test/site.css">')).toMatchObject([
      { what: '<link href="https://cdn.test/site.css">' },
    ]);
  });

  test("a style attribute's dropped declarations are reported at its tag", () => {
    const input = 'x<p style="color: red; background: url(https://x.test/a.png)">y</p>';
    expect(html(input)).toEqual([
      {
        what: "background: url(https://x.test/a.png)",
        why: "pictures load only from this workspace: attach it with write_note images and use the name it was stored as",
        at: 1,
      },
    ]);
  });

  test("code over the size cap is reported as removed entirely", () => {
    expect(html(`<p>${"x".repeat(300_001)}</p>`)).toMatchObject([{ what: "everything" }]);
  });
});

describe("the CSS sanitizer reports what it removes", () => {
  test("a clean sheet reports nothing", () => {
    expect(
      css(':root { --ink: #111; } body { color: var(--ink); background: url("logo.png"); } @media (width >= 40em) { h1 { font-size: 3rem; } } @keyframes fade { from { opacity: 0; } to { opacity: 1; } } @import url("https://fonts.googleapis.com/css2?family=Inter");'),
    ).toEqual([]);
  });

  test("declarations: a blocked property, an unknown function, a remote picture, a missing one", () => {
    const removals = css(
      '.a { color: red; behavior: url(x.htc); width: expression(alert(1)); background: url(https://x.test/a.png); border-image: url("nope.png"); }',
    );
    expect(removals.map((removal) => [removal.what, removal.why])).toEqual([
      ["behavior: url(x.htc)", "this property once ran code, so no site may use it"],
      ["width: expression(alert(1))", "expression() is not a CSS function a site can use"],
      ["background: url(https://x.test/a.png)", "pictures load only from this workspace: attach it with write_note images and use the name it was stored as"],
      ['border-image: url("nope.png")', 'no picture called "nope.png" is stored in this workspace, under that exact name'],
    ]);
  });

  test("a nested rule, a selector starting with a combinator, and at-rules a site cannot use", () => {
    const removals = css(
      '.a { color: red; &:hover { color: blue; } } > .b { color: red; } @font-face { font-family: X; src: url(x.woff); } @import url("https://cdn.test/x.css"); @page { margin: 0; }',
    );
    expect(removals.map((removal) => removal.why)).toEqual([
      "nested rules are not supported: write each rule with its full selector",
      "a selector cannot start with a combinator",
      "load fonts with a Google Fonts @import or <link> instead",
      "only Google Fonts stylesheets can be imported",
      "@page is not supported on a site",
    ]);
  });

  test("one bad selector in a list is reported alone, and the rule keeps the rest", () => {
    const removals = css(".a, .b & .c { color: red; }");
    expect(removals).toEqual([
      { what: "selector .b & .c", why: "nested rules are not supported: write the full selector" },
    ]);
  });
});
