/**
 * The page format (`packages/shared/src/pages/`), which the gateway, the app
 * and the page runtime all read: what a page draws from a note anybody with
 * write access wrote, and what the reader's typing writes back.
 *
 * The runtime is sealed (its own origin, a CSP that loads nothing), so these
 * are the second wall, and the one that keeps a page's words its words: every
 * word is escaped where it is drawn, a link goes only to a web, mail or phone
 * address, and what is typed over a run is written back so it stays words and
 * never becomes Markdown structure.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `esc` returning its input (`render.cjs`) → "every word is escaped" fails.
 *   `SAFE_HREF` accepting any scheme → "a link goes only to web, mail or phone" fails.
 *   `escapeText` returning its input (`inline.cjs`) → "typed punctuation stays
 *     words" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { applyRunEdits } from "../../../packages/shared/src/pages/edits.cjs";

function runOf(source, words) {
  for (const node of parsePage(source).nodes) {
    const runs = [...(node.runs ?? []), ...(node.items ?? []).flatMap((item) => [...(item.runs ?? []), ...(item.label?.runs ?? []), ...(item.parts ?? []).flatMap((p) => p.runs)])];
    const run = runs.find((r) => (r.text ?? "").includes(words));
    if (run) return run;
  }
  throw new Error(`no run with ${words}`);
}

test("every word is escaped, in prose, blocks and front matter", () => {
  const source = [
    "---",
    'title: "<img src=x onerror=alert(1)>"',
    "kicker: <b>k</b>",
    "---",
    "",
    "Hello <script>alert(1)</script> & \"you\"",
    "",
    "```compare <svg onload=alert(2)>",
    "- <i>Casa</i>: $29 | <iframe>",
    "- Ember: $33 | ok",
    "```",
    "",
  ].join("\n");
  const { html } = renderPage(parsePage(source));
  for (const tag of ["<img", "<script", "<b>", "<svg", "<i>", "<iframe"]) assert.ok(!html.includes(tag), tag);
  assert.match(html, /&lt;script&gt;/);
});

test("a link goes only to web, mail or phone", () => {
  const source = "[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com/x) [d](mailto:a@example.com)\n";
  const { html } = renderPage(parsePage(source));
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /data:text/);
  assert.match(html, /https:\/\/example\.com\/x/);
  assert.match(html, /mailto:a@example\.com/);
});

test("typed punctuation stays words, and a line break never starts a new block", () => {
  const source = "# Plan\n\nThe first line.\n";
  const run = runOf(source, "The first line.");
  const { text } = applyRunEdits(source, [{ from: run.from, to: run.to, text: "Now **bold** [x](y)\n```box\n<script>" }]);
  const page = parsePage(text);
  assert.equal(page.nodes.filter((node) => node.type === "box").length, 0);
  assert.equal(page.nodes.length, 2);
  // Read back, it is exactly what was typed (the line break as a space).
  assert.equal(runOf(text, "Now").text, "Now **bold** [x](y) ```box <script>");
  const { html } = renderPage(page);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<script/);
});
