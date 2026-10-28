/**
 * A TEX PAGE READS ON A PHONE AND SHOWS ITS THINGS (owner, 2026-10-28, on the
 * birthday rooftop plan: "there's not even a single picture here, it literally
 * still looks like a glorified markdown page"). What went wrong on that page,
 * each pinned here:
 *
 * - its three venues were a `choose` block, which no picture was hunted for,
 *   so the page and its cover had no photo at all;
 * - a hunted picture that came back as AVIF was taken as found and then
 *   dropped, so the hunt never tried the next one;
 * - its budget chart stood seven columns on a phone: "2000" wrapped as
 *   "200 / 0" and labels lifted their bars off the baseline;
 * - its six-column table ran off the screen;
 * - its cover was judged as an answer and held back ("a sentence would say it").
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   "choose" taken out of PICTURED_KINDS → "a choice's options get pictures" fails.
 *   The storable check in the hunt's download removed → "an AVIF is passed over
 *     for the next picture" fails.
 *   barChart's lying-down branch removed → "a breakdown of more than four" fails.
 *   The table's data-label dropped → "a wide table becomes cards" fails.
 *   COVER_RULE left out of the check's text → "a cover is judged as a cover" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { BASE_CSS } from "../../../packages/shared/src/pages/css.cjs";
import { PICTURED_KINDS, unpictured, withPagePictures } from "../src/agent/visuals/pagePhotos.js";
import { COVER_RULE, cardCheckFor } from "../src/agent/cardCheck.js";

const PLAN = [
  "---",
  "kind: plan",
  "skill: pages-test",
  "---",
  "# Birthday rooftop, Sat Nov 21",
  "",
  "```choose My pick: Avenida Rooftop",
  "- Avenida Rooftop: 1 Penn Plaza · heaters and awnings · $1,000 minimum",
  "- The Rutherford Rooftop: Same building · heaters",
  "- Ravel Penthouse: 5 min from home · glass retractable roof",
  "```",
  "",
].join("\n");

const html = (text) => renderPage(parsePage(text)).html;

function web(pictures = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push(args.query);
    const found = pictures[args.query] ?? [];
    return { content: [{ type: "text", text: ["These are picture search results.", `Picture search: ${args.query}`, "", found.length ? `Pictures found:\n${found.map(([alt, src]) => `- ${alt} - ${src}`).join("\n")}` : "(no pictures)"].join("\n") }] };
  };
  return { calls, call };
}

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const AVIF = `data:image/avif;base64,${btoa("\0\0\0\x1cftypavif\0\0\0\0avifmif1")}`;

test("a choice's options get pictures, searched with the place its words start with", async () => {
  assert.ok(PICTURED_KINDS.has("choose"));
  assert.deepEqual(
    unpictured(PLAN).map((option) => option.query),
    ["Avenida Rooftop 1 Penn Plaza", "The Rutherford Rooftop Same building", "Ravel Penthouse 5 min from home"],
  );
  const w = web({ "Avenida Rooftop 1 Penn Plaza": [["Avenida Rooftop", "https://cdn.example/avenida.jpg"]] });
  const { args, found } = await withPagePictures({ path: "plan.page.md", content: PLAN }, { web: w.call, download: async () => JPEG });
  assert.deepEqual(found, ["Avenida Rooftop"]);
  assert.match(args.content, /- Avenida Rooftop: [^\n]*\n {2}photo: avenida-rooftop-1\.jpg\n/);
  assert.deepEqual(parsePage(args.content).problems, []);
  // And the page draws it, on the option and as the plan's cover.
  const drawn = renderPage(parsePage(args.content)).html;
  assert.match(drawn, /class="pg-option pictured"[^>]*><div class="pg-ph[^"]*" data-i="A"><img data-src="avenida-rooftop-1\.jpg"/);
  assert.match(drawn, /<header class="pg-cover" data-kind="plan"><div class="pg-cover-col n1">/);
});

test("an AVIF is passed over for the next picture, so the page still gets one it can store", async () => {
  const w = web({ "Avenida Rooftop 1 Penn Plaza": [["Avenida Rooftop", "https://cdn.example/a.avif"], ["Avenida Rooftop terrace", "https://cdn.example/a.jpg"]] });
  const fetched = { "https://cdn.example/a.avif": AVIF, "https://cdn.example/a.jpg": JPEG };
  const { args, found } = await withPagePictures({ path: "plan.page.md", content: PLAN }, { web: w.call, download: async (address) => fetched[address] ?? null });
  assert.deepEqual(found, ["Avenida Rooftop"]);
  assert.equal(args.images[0].data.slice(0, 23), "data:image/jpeg;base64,");
});

const BUDGET = [
  "# Budget",
  "",
  "```chart Budget at Avenida",
  "unit: $",
  "- Food and drinks at venue: 2000",
  "- Gratuity 20%: 400",
  "- Admin fee 7.5%: 150",
  "- Card fee 2.75%: 55",
  "- Cake: 150",
  "- Decor and balloons: 150",
  "- Buffer: 95",
  "```",
].join("\n");

test("a breakdown of more than four lies down: one row each, the value as money, every bar to one scale", () => {
  const drawn = html(BUDGET);
  assert.doesNotMatch(drawn, /pg-bars-plot/);
  const rows = [...drawn.matchAll(/<div class="pg-hbar( top)?">.*?<b>([^<]*)<\/b>.*?width:([\d.]+)%/g)];
  assert.deepEqual(rows.map((m) => m[2]), ["$2,000", "$400", "$150", "$55", "$150", "$150", "$95"]);
  assert.deepEqual(rows.map((m) => Number(m[3])), [100, 20, 7.5, 2.8, 7.5, 7.5, 4.8]);
  assert.equal(rows.filter((m) => m[1]).length, 1, "the largest alone in the accent");
  assert.doesNotMatch(drawn, /pg-foot">\$</, "a currency unit is on the values, not in a caption");
});

test("a few short bars stand on one baseline: heights in pixels, values never wrapped", () => {
  const drawn = html(["# Weeks", "", "```chart Signups", "- W1: 12", "- W2: 30", "- W3: 24", "```"].join("\n"));
  assert.deepEqual([...drawn.matchAll(/<i style="height:(\d+)px"><\/i>/g)].map((m) => Number(m[1])), [60, 150, 120]);
  assert.match(BASE_CSS, /\.pg-bar\{height:186px;display:flex;flex-direction:column;justify-content:flex-end/);
  assert.match(BASE_CSS, /\.pg-bars-plot b\{[^}]*white-space:nowrap/);
});

test("a wide table becomes cards on a phone, each cell under its column's name", () => {
  const drawn = html(["# Venues", "", "| Venue | Price | Holds | Heated |", "|---|---|---|---|", "| Avenida | $1,000 | 250 | Yes |"].join("\n"));
  assert.match(drawn, /class="pg-table pg-table-cards"/);
  assert.match(drawn, /<td data-edit data-label="Holds">/);
  assert.match(BASE_CSS, /@container pg \(max-width:600px\)\{\n\.pg-table-cards/);
  assert.match(BASE_CSS, /\.pg-table-cards td::before\{content:attr\(data-label\)/);
  const narrow = html(["# Two", "", "| Day | Plan |", "|---|---|", "| Sat | Party |"].join("\n"));
  assert.match(narrow, /class="pg-table"/, "a narrow table stays a table");
});

test("a stat in words is set smaller than a figure, so it stays on one line", () => {
  const drawn = html(["# Plan", "", "```stats", "- Date: Sat Nov 21", "- Budget: $3,000", "```"].join("\n"));
  assert.match(drawn, /<div class="long"><b class="" data-edit>.*Sat Nov 21/);
  assert.match(drawn, /<div><b class="" data-edit>.*\$3,000/);
});

test("a cover with no photo starts its words below the app's floating buttons", () => {
  assert.match(BASE_CSS, /\.pg-cover-plain \.pg-cover-t\{padding-top:calc\(var\(--pg-top,0px\) \+ 36px\)\}/);
});

test("a cover is judged as a cover, and any other picture as an answer", async () => {
  const asked = [];
  const request = async (body) => (asked.push(body.messages[0].text), { text: '{"send": true}' });
  const check = cardCheckFor({ question: "plan my birthday", config: {}, request, log: () => {} });
  await check({ tool: "draw_visual", template: "page", picture: { data: "x", mediaType: "image/png" } });
  await check({ tool: "draw_visual", template: "places", picture: { data: "x", mediaType: "image/png" } });
  assert.ok(asked[0].endsWith(COVER_RULE));
  assert.ok(!asked[1].includes(COVER_RULE));
});
