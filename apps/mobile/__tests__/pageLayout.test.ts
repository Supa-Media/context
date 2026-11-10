/**
 * @jest-environment jsdom
 */
/**
 * A page's layout, as the frame draws it (`page-frame/layout.js`).
 *
 * The gateway refuses a bad layout at write (`packages/shared/src/pages/layout.cjs`),
 * but the frame never trusts that: it reads the layout with `DOMParser` and
 * keeps only what is on its list. Pinned: nothing that runs, loads, links or
 * poses as the runtime's own markers survives; every part is placed; a
 * section the layout doesn't name is never hidden.
 *
 * Sabotage: let every attribute through in `cleanLayout` and "nothing that
 * runs, loads or links survives" fails; drop the leftover sections in
 * `drawLayout` and "a section the layout doesn't place is still drawn" fails.
 */

import { expect, test } from "@jest/globals";
import { cleanLayout, drawLayout } from "../page-frame/layout.js";

const parts = {
  cover: '<header class="pg-cover"><h1>The roast</h1></header>',
  sections: [
    { key: "1. sign-in is slow", html: '<section class="pg-section" data-section="0"><h2>1. Sign-in is slow</h2></section>' },
    { key: "2. search misses", html: '<section class="pg-section" data-section="1"><h2>2. Search misses</h2></section>' },
    { key: "fix first", html: '<section class="pg-section" data-section="2"><h2>Fix first</h2></section>' },
  ],
};

test("nothing that runs, loads or links survives", () => {
  const sly =
    '<div data-from="cover" onclick="x()" id="page" data-edit data-box="0" data-src="a.png" style="color:red"></div>' +
    '<script>alert(1)</script><iframe></iframe><img src="https://x.example/a.png"><a href="https://x.example">go</a>' +
    '<svg><a href="javascript:alert(1)"></a></svg><form><input></form>' +
    '<style>.a{color:blue}</style><style>@import "https://x.example/a.css";</style>' +
    '<p style="background:url(https://x.example/t.png)" class="k" aria-label="ok">words</p>';
  const { fragment, css } = cleanLayout(sly);
  const box = document.createElement("div");
  box.appendChild(fragment);
  const html = box.innerHTML;
  expect(html).not.toMatch(/onclick|<script|<iframe|<img|<a |<svg|<form|<input|x\.example|data-edit|data-box|data-src|id=/);
  expect(html).toContain('data-from="cover"');
  expect(html).toContain('style="color:red"');
  expect(html).toContain('class="k" aria-label="ok"');
  expect(html).toContain(">words</p>");
  expect(css).toBe(".a{color:blue}");
});

test("each part goes where the layout names it", () => {
  const root = document.createElement("div");
  const css = drawLayout(
    root,
    '<style>.g{display:grid}</style><div class="g"><div data-from="2. Search  MISSES"></div><div data-from="1. Sign-in is slow"></div></div><div data-from="cover"></div><div data-from="rest"></div>',
    parts,
  );
  expect(css).toBe(".g{display:grid}");
  const order = [...root.querySelectorAll("h1, h2")].map((h) => h.textContent);
  expect(order).toEqual(["2. Search misses", "1. Sign-in is slow", "The roast", "Fix first"]);
});

test("a section the layout doesn't place is still drawn, and so is an unplaced cover", () => {
  const root = document.createElement("div");
  drawLayout(root, '<aside data-from="fix first"></aside>', parts);
  const order = [...root.querySelectorAll("h1, h2")].map((h) => h.textContent);
  expect(order).toEqual(["The roast", "Fix first", "1. Sign-in is slow", "2. Search misses"]);
});
