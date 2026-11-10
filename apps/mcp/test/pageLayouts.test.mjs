/**
 * A PAGE'S OWN LAYOUT (owner, 2026-11-10: pages "extensible enough for custom
 * Ui using html css", "similar to instinct").
 *
 * A ```` ```layout ```` fence is HTML that places the page's parts by
 * `data-from`; the words stay Markdown. What is pinned here, at write:
 *  - a layout that runs, loads, submits or names an address is refused with
 *    what to fix, and one that places nothing or names a section the page
 *    doesn't have is refused too;
 *  - a page has one layout;
 *  - the renderer hands the runtime the layout and the parts to put in it,
 *    every section by its heading's key, and a page without one is drawn as
 *    before;
 *  - the page design skill tells writers about it.
 * The frame's own cleaning is pinned in `apps/mobile/__tests__/pageLayout.test.ts`.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page can have a layout of its own".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-10).
 *   `CHECKS` without the banned-tag pattern → "a layout that runs or loads is refused" fails.
 *   `parsePage` without the layout pass → "a layout naming a missing section is refused" fails.
 *   `renderPage` handing on a layout with problems → "a page without a layout draws as before, and a broken one is left out" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { layoutSlots } from "../../../packages/shared/src/pages/layout.cjs";
import { pageProblems } from "../src/pages.js";
import { PAGE_SKILL } from "../src/pageSkill.js";

const page = (layout) =>
  `---\nskill: x\n---\n\n# The roast\n\nWhat we found.\n\n## 1. Sign-in is slow\n\nIt takes 9 s.\n\n## 2. Search misses\n\nHalf the time.\n\n## Fix first\n\n- [ ] Cache it\n${layout === null ? "" : `\n\`\`\`layout\n${layout}\n\`\`\`\n`}`;

const GOOD = `<style>.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}</style>
<div data-from="cover"></div>
<div class="grid"><div data-from="1. Sign-in is slow"></div><div data-from="2. search  MISSES"></div></div>
<div data-from="rest"></div>`;

test("a layout that places the page's sections is accepted", () => {
  const parsed = parsePage(page(GOOD));
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(layoutSlots(GOOD), ["cover", "1. Sign-in is slow", "2. search  MISSES", "rest"]);
});

test("a layout that runs or loads is refused", () => {
  const bad = [
    '<div data-from="cover"></div><script>alert(1)</script>',
    '<div data-from="cover" onclick="x()"></div>',
    '<div data-from="cover"></div><iframe></iframe>',
    '<div data-from="cover"></div><a href="https://x.example">x</a>',
    '<div data-from="cover"></div><img src="https://x.example/a.png">',
    '<style>@import "https://x.example/a.css";</style><div data-from="cover"></div>',
    '<style>.a{background:url(https://x.example/t.png)}</style><div data-from="cover"></div>',
    '<div data-from="cover" style="background:url(\'//x.example\')"></div>',
    '<div data-from="cover"></div><form></form>',
    '<div data-from="cover"></div><svg><a xlink:href="javascript:alert(1)"/></svg>',
  ];
  for (const layout of bad) {
    const refusal = pageProblems(page(layout));
    assert.ok(refusal, layout);
    assert.match(refusal, /not saved[\s\S]*can't/, layout);
  }
});

test("a layout naming a missing section, or placing nothing, is refused", () => {
  assert.match(parsePage(page('<div data-from="3. Billing"></div>')).problems[0].message, /names no ## section/);
  assert.match(parsePage(page("<div>Nothing here</div>")).problems[0].message, /places nothing/);
});

test("a page has one layout", () => {
  const twice = page(GOOD) + "\n```layout\n<div data-from=\"rest\"></div>\n```\n";
  assert.match(parsePage(twice).problems.map((p) => p.message).join(" "), /one layout/);
});

test("the renderer hands the runtime the layout and its parts", () => {
  const out = renderPage(parsePage(page(GOOD)));
  assert.equal(out.layout, GOOD);
  assert.match(out.parts.cover, /<h1[^>]*>.*The roast/);
  assert.deepEqual(out.parts.sections.map((s) => s.key), ["1. sign-in is slow", "2. search misses", "fix first"]);
  assert.match(out.parts.sections[0].html, /^<section class="pg-section"[^>]*>.*It takes 9 s/);
  assert.doesNotMatch(out.html, /data-from|<style>/, "the layout never reaches the page's HTML as words");
});

test("a page without a layout draws as before, and a broken one is left out", () => {
  const plain = renderPage(parsePage(page(null)));
  assert.equal(plain.layout, null);
  assert.equal(plain.parts, null);
  const broken = renderPage(parsePage(page('<div data-from="cover"></div><script>x</script>')));
  assert.equal(broken.layout, null);
  assert.doesNotMatch(broken.html, /<script|data-from/);
  assert.equal(broken.html, plain.html);
});

test("the page design skill tells writers about layouts", () => {
  assert.match(PAGE_SKILL, /```layout/);
  assert.match(PAGE_SKILL, /data-from=\\?"rest\\?"/);
});
