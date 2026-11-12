/**
 * The web-facts bench (`tests/web-facts.md`, 2026-11-11) measures whether Tex
 * takes an exact fact from the page that owns it. That holds only while each
 * search lists a stale or secondary snippet beside the owning page, the owning
 * page's own snippet (its first text line, `sites.mjs`) does not give the
 * answer away, and every page a `must reach` line names can be opened.
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

// A search each case would run, the page that owns the answer, the answer, and the stale figure a snippet offers.
const TRAPS = [
  ["lumendb latest release", "lumendb.example/releases", /4\.3\.1/, /4\.2/],
  ["ferro notes pro price", "ferro.example/pricing", /\$15/, /\$12/],
  ["port alder mayor", "portalder.example/mayor", /Okafor/, /Whitlock/],
  ["harborview marathon course record", "harborviewmarathon.example/records", /2:07:55/, /2:08:41/],
  ["tidewater route 14 sunday last bus", "tidewatertransit.example/routes/14", /10:55/, /11:40/],
  ["brightwell foods ceo", "brightwell.example/leadership", /Santos/, /Mercer/],
  ["typescript latest version", "github.com/microsoft/typescript-go/releases/tag/typescript%2fv7.0.2", /Jul 8/, /months ago/],
];

test("every web-facts case is a gate, its reach lines are scripted pages, and each search sets a snippet trap", async () => {
  const all = await sites();
  const { front, questions } = parseTest(await readFile(join(AI, "tests", "web-facts.md"), "utf8"));
  assert.equal(front.web, "scripted");
  assert.ok(questions.length >= 10 && questions.length <= 14, `${questions.length} questions`);
  const places = all.flatMap((site) => [...site.pages.values()].map((page) => placeOf(page.url).toLowerCase()));
  for (const q of questions) {
    assert.equal(q.kind, "task", `question ${q.n} is a gate`);
    for (const check of q.checks.filter((c) => c.what === "reach")) {
      const prefix = check.value.toLowerCase();
      assert.ok(places.some((place) => place.startsWith(prefix)), `question ${q.n}: no scripted page under ${prefix}`);
    }
  }
  assert.ok(questions.filter((q) => q.checks.some((c) => c.what === "reach")).length >= 10, "nearly every case must open the owning page");
  const web = createWeb(all);
  for (const [query, owner, answer, stale] of TRAPS) {
    const results = web.search(query).map((r) => ({ ...r, place: placeOf(r.url).toLowerCase() }));
    const owning = all.flatMap((site) => [...site.pages.values()]).find((page) => placeOf(page.url).toLowerCase() === owner);
    assert.ok(owning && answer.test(owning.text.map((t) => t.line).join(" ")), `${query}: the owning page holds the answer`);
    assert.ok(results.some((r) => r.place.startsWith(owner.split("/")[0])), `${query}: the owner's site is listed`);
    for (const r of results) assert.doesNotMatch(r.description, answer, `${query}: ${r.url} gives the answer in its snippet`);
    assert.ok(results.some((r) => stale.test(`${r.title} ${r.description}`)), `${query}: a stale snippet is listed beside it`);
  }
});
