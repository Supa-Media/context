/**
 * A COMPARISON SHOWS EACH THING (Dev2, 2026-10-27: "we need to show
 * screenshots of the things PLEASE, Tex needs to stop quitting so soon, it
 * has a whole computer").
 *
 * Two failures, both fixed here:
 *
 * - The turn's web tools ran beside the dispatcher that `outgoingPictures`
 *   watches, so no page or picture search a texted turn read was ever "read":
 *   every web photo on a card was dropped as unread. `outgoing.wrapWeb`
 *   reads them like any tool result (`route.js` wires the turn's web through it).
 * - An option with no photo went out blank whenever the model didn't go
 *   looking. `visuals/hunt.js` now searches pictures for it, else photographs
 *   its own page, before the card is drawn.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `wrapWeb` returning `web` unwrapped → "a photo on a page read through the
 *     web tools goes on the card" fails.
 *   `huntPhotos` returning `none` always → "an option with no photo gets one
 *     from a picture search" and "…its own page photographed" fail.
 *   `HUNTED_TEMPLATES` with `steps` added → "a card that compares nothing is
 *     not hunted for" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OPEN_PAGE_TOOL, SEARCH_WEB_TOOL } from "../src/agent/computer.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { VISUAL_TOOL } from "../src/agent/visuals/index.js";
import { HUNTED_TEMPLATES, huntPhotos, pageNamed } from "../src/agent/visuals/hunt.js";

const CARD_PNG = "iVBORw0KGgo=";
const SHOT_JPEG = "c2NyZWVuc2hvdA==";
const LISBON = "https://cdn.photos.example/lisbon.jpg";
const BROKEN = "https://cdn.photos.example/broken.jpg";

/** The screenshot Worker: `/render` draws the card, `/shoot` photographs a page. */
function siteShots({ shoot = true } = {}) {
  const calls = [];
  return {
    calls,
    SITE_SHOTS: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        if (url.endsWith("/shoot")) {
          if (!shoot) return Response.json({ shots: [], failures: [{ size: "desktop", reason: "timed out" }] });
          return Response.json({ shots: [{ size: "desktop", width: 1280, height: 800, jpeg: SHOT_JPEG }], failures: [] });
        }
        return Response.json({ png: CARD_PNG, width: body.width, height: body.height, blocked: [] });
      },
    },
  };
}

/** Pictures download unless refused. */
function photosFetch(refuse = []) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (refuse.includes(String(url))) return new Response("no", { status: 403 });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "content-type": "image/jpeg" } });
    },
  };
}

/** The turn's web tools, answering from tables, logging each call. */
function webTools({ pictures = {}, results = {}, pages = {} } = {}) {
  const calls = [];
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  return {
    calls,
    tools: [{ name: SEARCH_WEB_TOOL }, { name: OPEN_PAGE_TOOL }],
    async call(name, args) {
      calls.push({ name, args });
      if (name === OPEN_PAGE_TOOL) return text(pages[args.url] ?? "(no page)");
      if (args.pictures === true) {
        const found = pictures[args.query] ?? [];
        return text(["These are picture search results.", `Picture search: ${args.query}`, "", found.length ? `Pictures found (a photo for draw_visual):\n${found.map(([alt, src]) => `- ${alt} - ${src}`).join("\n")}` : "(no pictures)"].join("\n"));
      }
      const found = results[args.query] ?? [];
      return text(["These are web search results.", `Search: ${args.query}`, "", found.length ? found.map(([title, url], i) => `${i + 1}. ${title} - ${url}`).join("\n") : "(no results)"].join("\n"));
    },
  };
}

/** A texted turn as `route.js` wires it: web through `outgoing.wrapWeb`, the maker hunting through it. */
function turn({ web, shots = siteShots(), fetchImpl = photosFetch().fetchImpl, question = "compare lisbon and porto for a long weekend, show me" } = {}) {
  const outgoing = outgoingPictures({ enabled: true, question });
  const seen = outgoing.wrapWeb(web);
  const maker = pictureMaker(shots, { outgoing, fetchImpl });
  maker.useWeb((name, args) => seen.call(name, args));
  const draw = outgoing.wrap(withPictureMaker(maker, async () => ({ content: [{ type: "text", text: "ok" }] })));
  return { seen, draw, shots };
}

const said = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
const cardHtml = (shots) => shots.calls.find((call) => call.url.endsWith("/render")).body.html;

test("a photo on a page read through the web tools goes on the card", async () => {
  const page = ["This is the content of a web page.", "Title: Lisbon travel guide", "Address: https://travel.example/lisbon", "", "Lisbon is hilly.", "", "Pictures on the page (a photo for draw_visual):", `- Lisbon trams - ${LISBON}`].join("\n");
  const web = webTools({ pages: { "https://travel.example/lisbon": page } });
  const { seen, draw, shots } = turn({ web });
  await seen.call(OPEN_PAGE_TOOL, { url: "https://travel.example/lisbon" });
  const result = await draw(VISUAL_TOOL, { template: "option", data: { index: 1, of: 2, name: "Lisbon", photo: LISBON } });
  assert.match(cardHtml(shots), /url\('data:image\/jpeg;base64,/, "the read photo, downloaded into the card");
  assert.doesNotMatch(said(result), /left off the card/);
  assert.equal(web.calls.filter((call) => call.args.pictures === true).length, 0, "nothing hunted: it had its photo");
});

test("an option with no photo gets one from a picture search", async () => {
  const web = webTools({ pictures: { Porto: [["Porto riverside Ribeira", "https://cdn.photos.example/porto.jpg"]] } });
  const { draw, shots } = turn({ web });
  const result = await draw(VISUAL_TOOL, { template: "option", data: { index: 2, of: 2, name: "Porto", price: "$480" } });
  assert.deepEqual(web.calls[0], { name: SEARCH_WEB_TOOL, args: { query: "Porto", pictures: true } });
  assert.match(cardHtml(shots), /url\('data:image\/jpeg;base64,/);
  assert.match(said(result), /Photos found by a picture search for: Porto\./);
});

test("a places card searches each place with where they are, the named picture first, the next when one won't come", async () => {
  const web = webTools({
    pictures: {
      "Hav and Mar Chelsea, NY": [
        ["Some other bar", "https://cdn.photos.example/other.jpg"],
        ["Hav and Mar dining room", BROKEN],
        ["Hav & Mar shrimp", "https://cdn.photos.example/havmar-shrimp.jpg"],
      ],
    },
  });
  const fetched = photosFetch([BROKEN]);
  const { draw, shots } = turn({ web, fetchImpl: fetched.fetchImpl });
  await draw(VISUAL_TOOL, { template: "places", data: { title: "Dinner", near: "Chelsea, NY", items: [{ name: "Hav and Mar" }] } });
  const tried = fetched.asked.filter((url) => url.startsWith("https://cdn.photos.example/"));
  assert.deepEqual(tried, [BROKEN, "https://cdn.photos.example/havmar-shrimp.jpg"], "named pictures first, the broken one skipped");
  assert.match(cardHtml(shots), /url\('data:image\/jpeg;base64,/);
});

test("with no picture to be found, its own page is photographed: a search result titled with it", async () => {
  const web = webTools({ results: { "Ethiopian food": [["Ethiopian food - Wikipedia", "https://encyclopedia.example/ethiopian"]] } });
  const shots = siteShots();
  const { seen, draw } = turn({ web, shots });
  await seen.call(SEARCH_WEB_TOOL, { query: "Ethiopian food" });
  const result = await draw(VISUAL_TOOL, { template: "gallery", data: { style: "warm", title: "Tonight", items: [{ name: "Ethiopian food" }] } });
  const shoot = shots.calls.find((call) => call.url.endsWith("/shoot"));
  assert.deepEqual(shoot.body, { url: "https://encyclopedia.example/ethiopian", sizes: ["desktop"] });
  assert.ok(cardHtml(shots).includes(`data:image/jpeg;base64,${SHOT_JPEG}`), "the page's screenshot is the photo");
  assert.match(said(result), /Screenshots of their own pages for: Ethiopian food\./);
});

test("with no page read yet, one web search finds the page to photograph", async () => {
  const web = webTools({ results: { "Portugal": [["Visit Portugal - official", "https://visitportugal.example/"]] } });
  const shots = siteShots();
  const { draw } = turn({ web, shots });
  await draw(VISUAL_TOOL, { template: "versus", data: { title: "Where to go", items: [{ name: "Portugal" }, { name: "Spain" }], rows: [] } });
  assert.ok(web.calls.some((call) => call.args.query === "Portugal" && call.args.pictures !== true));
  assert.equal(shots.calls.filter((call) => call.url.endsWith("/shoot")).length, 1, "Spain had no page to photograph");
});

test("what is still missing after both is named in the result, so the model goes and looks", async () => {
  const { draw } = turn({ web: webTools(), shots: siteShots({ shoot: false }) });
  const result = await draw(VISUAL_TOOL, { template: "option", data: { name: "Mystery dish" } });
  assert.match(said(result), /No picture found yet for: Mystery dish\. Open each one's own page/);
});

test("a card that compares nothing is not hunted for", async () => {
  assert.equal(HUNTED_TEMPLATES.has("steps"), false);
  const web = webTools({ pictures: { Boil: [["Boil", "https://cdn.photos.example/boil.jpg"]] } });
  const { draw } = turn({ web });
  await draw(VISUAL_TOOL, { template: "steps", data: { title: "Pasta", steps: [{ title: "Boil" }] } });
  assert.equal(web.calls.length, 0);
});

test("a picture the person sent or Tex drew is kept, never searched over", async () => {
  let searched = 0;
  const hunt = await huntPhotos("option", { name: "Their dress", photo: "attachment:1" }, { web: async () => (searched += 1, { content: [] }), download: async () => "data:x" });
  assert.equal(searched, 0);
  assert.equal(hunt.data.photo, "attachment:1");
});

test("a hunt that hangs is cut off and the card goes without it", async () => {
  const started = Date.now();
  const hunt = await huntPhotos("option", { name: "Slow place" }, { web: () => new Promise(() => {}), download: async () => null, timeoutMs: 50 });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(hunt.missing, ["Slow place"]);
});

test("pageNamed finds only a result titled with the thing, as whole words", () => {
  const read = "1. Barcelona travel - https://a.example/bcn\n2. Porto guide - https://a.example/porto";
  assert.equal(pageNamed(read, "Porto"), "https://a.example/porto");
  assert.equal(pageNamed(read, "Port"), null);
});

test("without the web (a turn that has none) a hunt never throws and finds nothing", async () => {
  const outgoing = outgoingPictures({ enabled: true, question: "x" });
  assert.equal(outgoing.wrapWeb(null), null);
  const hunt = await huntPhotos("option", { name: "Lisbon" }, { download: async () => null });
  assert.deepEqual(hunt.missing, ["Lisbon"]);
});
