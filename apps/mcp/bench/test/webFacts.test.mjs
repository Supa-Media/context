/**
 * The web-facts bench (`tests/web-facts.md`, 2026-11-11) measures whether Tex
 * takes an exact fact from the page that owns it. That holds only while no
 * search snippet carries the answer's date (a snippet is a page's first text
 * line, `sites.mjs`), and every page a `must reach` line names is a scripted
 * page the run can open.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createWeb, parseSite, placeOf } from "../sites.mjs";
import { parseTest } from "../load.mjs";

const AI = fileURLToPath(new URL("../ai", import.meta.url));

async function sites() {
  const dir = join(AI, "sites");
  const out = [];
  for (const name of (await readdir(dir)).sort()) out.push(parseSite(await readFile(join(dir, name), "utf8"), name));
  return out;
}

const MONTH_DAY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b|\b20\d\d-\d\d-\d\d\b/;

test("every web-facts question is a gate, its reach lines are scripted pages, and no snippet gives a date away", async () => {
  const all = await sites();
  const { front, questions } = parseTest(await readFile(join(AI, "tests", "web-facts.md"), "utf8"));
  assert.equal(front.web, "scripted");
  assert.ok(questions.length >= 8 && questions.length <= 12, `${questions.length} questions`);
  const places = all.flatMap((site) => [...site.pages.values()].map((page) => placeOf(page.url).toLowerCase()));
  for (const q of questions) {
    assert.equal(q.kind, "task", `question ${q.n} is a gate`);
    for (const check of q.checks.filter((c) => c.what === "reach")) {
      const prefix = check.value.toLowerCase();
      assert.ok(places.some((place) => place.startsWith(prefix)), `question ${q.n}: no scripted page under ${prefix}`);
    }
  }
  assert.ok(questions.filter((q) => q.checks.some((c) => c.what === "reach")).length >= 6, "most questions must open the owning page");
  const web = createWeb(all);
  for (const query of ["typescript release date", "rust latest", "react version", "deno release", "vite version"]) {
    const results = web.search(query);
    assert.ok(results.length > 0, query);
    for (const result of results) assert.doesNotMatch(result.description, MONTH_DAY, `${query}: ${result.url}`);
  }
});
