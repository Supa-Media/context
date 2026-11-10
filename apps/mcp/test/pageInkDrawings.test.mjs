/**
 * DRAWINGS INSIDE A PAGE (owner, 2026-11-10, "Both, in that order": pages
 * "were supposed to have drawings using Tex styling", and Tex's ink was only
 * ever on the cover).
 *
 * A ```` ```drawing <caption> ```` fence is the same scene a cover takes
 * (`ink/drawing.cjs`): SVG shapes read into numbers and written again, so the
 * page draws Tex's ink and nothing the writer typed. What is pinned:
 *  - a drawing renders in both inks, cropped, with its caption, and the
 *    page's theme picks one;
 *  - nothing the writer puts in a scene (a script, a handler, a link, a
 *    colour) reaches the page;
 *  - a scene that can't be drawn is a problem, so the write is refused with
 *    what to fix, not saved as a blank;
 *  - two drawings never share an id, so one's hatch is never the other's;
 *  - the page design skill tells writers about it.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`, "Drawings inside a page".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-10).
 *   `fenced` treating `drawing` as a code fence → "a drawing renders in both inks" fails.
 *   `drawingFigure` without the id rewrite → "two drawings never share an id" fails.
 *   `fenced` dropping the scene's error → "a scene that can't be drawn is refused" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { pageProblems } from "../src/pages.js";
import { PAGE_SKILL } from "../src/pageSkill.js";

const SCENE = '<rect x="60" y="330" width="230" height="170" rx="24" fill="paper"/><text x="175" y="425" font-size="44">Phone</text><path d="M290 415 L470 415" fill="none"/>';
const page = (body) => `---\nskill: x\n---\n\n# Moving\n\nWords first.\n\n## How it flows\n\n${body}\n`;

test("a drawing renders in both inks, cropped, with its caption", () => {
  const { html } = renderPage(parsePage(page("```drawing How a text reaches Tex\n" + SCENE + "\n```")));
  assert.match(html, /<figure class="pg-ink-figure"/);
  assert.match(html, /<svg [^>]*viewBox="90 110 1020 820"[^>]*class="pg-ink-light"/);
  assert.match(html, /class="pg-ink-dark"/);
  assert.match(html, /<figcaption>How a text reaches Tex<\/figcaption>/);
  assert.match(html, />Phone</);
  assert.match(html, /#2A45CF/, "Tex's light ink");
  assert.match(html, /#8A9BF2/, "Tex's dark ink");
});

test("nothing the writer puts in a scene reaches the page", () => {
  const sly = '<rect x="1" y="1" width="9" height="9" onload="alert(1)" style="fill:red" fill="#ff0000"/><text x="5" y="5">hi &lt;b&gt;</text>';
  const { html } = renderPage(parsePage(page("```drawing\n" + sly + "\n```")));
  assert.doesNotMatch(html, /onload|alert|style="fill|#ff0000/i);
  assert.doesNotMatch(html, /<b>/);
  for (const bad of ['<script>alert(1)</script>', '<image href="https://x.example/a.png"/>', '<a href="https://x.example"><rect x="1" y="1" width="2" height="2"/></a>']) {
    const parsed = parsePage(page("```drawing\n" + bad + "\n```"));
    assert.ok(parsed.problems.length > 0, bad);
    assert.doesNotMatch(renderPage(parsed).html, /<script|<image|<a |x\.example/);
  }
});

test("a scene that can't be drawn is refused, with what to fix", () => {
  const problems = pageProblems(page("```drawing\n<foreignObject/>\n```"));
  assert.ok(problems, "refused");
  assert.match(problems, /can't be drawn/);
  assert.equal(pageProblems(page("```drawing\n" + SCENE + "\n```")), null);
});

test("two drawings never share an id", () => {
  const { html } = renderPage(parsePage(page("```drawing\n" + SCENE + "\n```\n\n```drawing\n" + SCENE + "\n```")));
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 12);
  assert.equal(new Set(ids).size, ids.length);
});

test("the page design skill tells writers how to draw one", () => {
  assert.match(PAGE_SKILL, /```` ```drawing <caption> ````/);
  assert.ok(PAGE_SKILL.includes("a `drawing`, your simple line drawing"));
});
