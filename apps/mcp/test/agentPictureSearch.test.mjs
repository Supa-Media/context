/**
 * PICTURES FOUND BY WORDS (owner, 2026-10-27: "why isn't it adding images?"):
 * a WhatsApp group asked for a caterer's dishes "with pictures and prices",
 * and the option cards went out with a letter where each dish should be. The
 * caterer's site had no photo of each dish, and Tex had nowhere else to look.
 * Now `search_web` takes `pictures: true` (Brave's image search), the results
 * fill a card's photos by name like a page's do (`visuals/photos.js`), a
 * result that won't download falls back to the provider's smaller copy, and
 * an option card with no photo has no photo slot at all.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `pagesIn` splitting on web pages only → "a picture search fills an
 *     option card's photo by name" fails.
 *   `downloadPhotos` ignoring `spares` → "a searched picture that won't
 *     download comes from the smaller copy" fails.
 *   The initial put back in `option` → "an option card with no photo has no
 *     letter in an empty block" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SEARCH_WEB_TOOL, webSession } from "../src/agent/computer.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { searcherFor } from "../src/agent/search.js";
import { VISUAL_TOOL, buildVisual } from "../src/agent/visuals/index.js";

const CARD_PNG = "iVBORw0KGgo=";
const BOXED = "https://cdn.caterer.example/boxed-lunch.jpg";
const BOXED_COPY = "https://imgs.search.example/thumb/boxed.jpg";
const WRAPS = "https://cdn.caterer.example/wrap-platter.jpg";

function siteShots() {
  const calls = [];
  return {
    calls,
    SITE_SHOTS: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        return new Response(JSON.stringify({ png: CARD_PNG, width: body.width, height: body.height, blocked: [] }), { status: 200 });
      },
    },
  };
}

/** Brave's image search answering one query, and the pictures that download. */
function web({ refuse = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.startsWith("https://api.search.brave.com/res/v1/images/search")) {
      return Response.json({
        results: [
          { title: "Smart Value Caterers boxed lunch", url: "https://caterer.example/menu", properties: { url: BOXED }, thumbnail: { src: BOXED_COPY } },
          { title: "Sandwich & wrap platters", url: "https://caterer.example/platters", properties: { url: WRAPS }, thumbnail: { src: "https://imgs.search.example/thumb/wraps.jpg" } },
          { title: "not https", url: "http://x.example", properties: { url: "http://x.example/a.jpg" } },
        ],
      });
    }
    if (refuse.includes(url)) return new Response("no", { status: 403 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  return { asked, fetchImpl };
}

async function caterersTurn(fetchImpl) {
  const shots = siteShots();
  const question = "Tex, show me the different things Smart Value Caterers cater, I'd like to see pictures and prices";
  const outgoing = outgoingPictures({ enabled: true, question });
  const session = webSession(null, question, { search: searcherFor({ BRAVE_SEARCH_API_KEY: "brave-example-not-a-real-key" }, { fetchImpl }) });
  const maker = pictureMaker(shots, { outgoing, fetchImpl });
  const call = outgoing.wrap(withPictureMaker(maker, (name, args) => session.call(name, args)));
  const found = await call(SEARCH_WEB_TOOL, { query: "Smart Value Caterers boxed lunch", pictures: true });
  return { shots, call, found };
}

test("a picture search lists photos by name, https only, with the smaller copy beside each", async () => {
  const { found } = await caterersTurn(web().fetchImpl);
  const said = found.content[0].text;
  assert.match(said, /^These are picture search results\./);
  assert.match(said, new RegExp(`- Smart Value Caterers boxed lunch - ${BOXED} \\(smaller copy: ${BOXED_COPY}\\)`));
  assert.doesNotMatch(said, /http:\/\//);
});

test("a picture search fills an option card's photo by name, downloaded into the card", async () => {
  const { shots, call } = await caterersTurn(web().fetchImpl);
  const result = await call(VISUAL_TOOL, { template: "option", data: { index: 2, of: 6, name: "Boxed lunch", price: "$14", source: "Smart Value" } });
  const html = shots.calls[0].body.html;
  assert.match(html, /url\('data:image\/jpeg;base64,/, "the searched photo, as data");
  assert.match(result.content[1].text, /added from the pages you read for: Boxed lunch/);
});

test("a searched picture that won't download comes from the smaller copy", async () => {
  const w = web({ refuse: [BOXED] });
  const { shots, call } = await caterersTurn(w.fetchImpl);
  await call(VISUAL_TOOL, { template: "option", data: { name: "Boxed lunch", photo: BOXED } });
  assert.ok(w.asked.includes(BOXED_COPY));
  assert.match(shots.calls[0].body.html, /url\('data:image\/jpeg;base64,/);
});

test("an option card with no photo has no letter in an empty block, and a long fact is shown whole", () => {
  const built = buildVisual({ template: "option", data: { index: 2, of: 6, name: "Boxed lunch", price: "$14", tag: "Best value", facts: [{ label: "Main", value: "Sandwich, salad or burger" }] } });
  assert.doesNotMatch(built.html, /font-size: 160px/);
  assert.doesNotMatch(built.html, /background-color: #?[0-9A-Fa-f]{3,8}; *">/);
  assert.match(built.html, /Sandwich, salad or burger</);
  assert.match(built.html, />2 of 6</);
  assert.match(built.html, />Best value</);
});
