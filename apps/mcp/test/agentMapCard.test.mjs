/**
 * A MAP ON THE CARD (owner, 2026-10-27: "there was a map one specifically
 * that would've been great here"): a places card shows its places on a map,
 * pins numbered like its rows, and the `map` template is stops on a map.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `vouchedAddress` always true → "an address the turn never read goes to
 *     no map service" fails.
 *   `clean` keeping `|` → "an address cannot add a marker or a style to
 *     Google's request" fails.
 *   `buildVisual` taking `map` from the model's data → "a map the model
 *     wrote is never drawn" fails.
 *   `drawMap` keeping a map with a missing tile → "a map whose tiles do not
 *     all come is left off whole" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { VISUAL_TEMPLATES, VISUAL_TOOL, buildVisual } from "../src/agent/visuals/index.js";
import { MAP_HEIGHT, MAX_TILES, drawMap, googleMapUrl, mapStops, tileLayout, worldPixel } from "../src/agent/visuals/map.js";

const CARD_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const KEY = "test-maps-key-not-real";

function siteShots(extra = {}) {
  const calls = [];
  return {
    calls,
    ...extra,
    SITE_SHOTS: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        return new Response(JSON.stringify({ png: CARD_PNG, width: body.width, height: body.height, blocked: [] }), { status: 200 });
      },
    },
  };
}

/** Map services: every image request answers with a PNG, unless `refuse` says otherwise; each request kept. */
function mapWeb(refuse = () => false) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), init });
    if (refuse(String(url))) return new Response("no", { status: 429 });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
  };
  return { asked, fetchImpl };
}

/** Long Island City, roughly: what the geocoder answers, as `distance.js` does ({ lat, lon }). */
const SPOTS = {
  "2807 Jackson Ave, Long Island City, NY": { lat: 40.7489, lon: -73.9375 },
  "2143 44th Rd, Long Island City, NY": { lat: 40.7484, lon: -73.9462 },
  "2337 Borden Ave, Long Island City, NY": { lat: 40.7406, lon: -73.9447 },
};
const geocode = async (address) => SPOTS[address] ?? null;

const READ = "Flower Queens, 2807 Jackson Ave. Ode à la Rose, 2143 44th Rd. Winston Flowers, 2337 Borden Ave.";
const FLORISTS = {
  title: "Florists in Long Island City",
  near: "Long Island City, NY",
  items: [
    { name: "Flower Queens", address: "2807 Jackson Ave", pick: true },
    { name: "Ode à la Rose", address: "2143 44th Rd" },
    { name: "Winston Flowers", address: "2337 Borden Ave" },
  ],
};

test("a places card's stops are its addresses, numbered like its rows, each made whole with near", () => {
  const stops = mapStops("places", FLORISTS);
  assert.deepEqual(stops.map((s) => [s.n, s.address]), [
    [1, "2807 Jackson Ave, Long Island City, NY"],
    [2, "2143 44th Rd, Long Island City, NY"],
    [3, "2337 Borden Ave, Long Island City, NY"],
  ]);
  assert.equal(mapStops("places", { near: "Brooklyn", items: [{ address: "12 Smith St, Brooklyn" }] })[0].address, "12 Smith St, Brooklyn", "an address that names its town is left as it is");
  assert.deepEqual(mapStops("compare", FLORISTS), [], "only places and map cards have a map");
});

test("an address cannot add a marker or a style to Google's request", () => {
  const [stop] = mapStops("map", { stops: [{ address: "1 Main St|markers=color:red|label:X|Times Square" }] });
  const url = new URL(googleMapUrl([stop], { key: KEY }));
  assert.equal(url.searchParams.getAll("markers").length, 1);
  assert.doesNotMatch(url.searchParams.get("markers"), /\|markers=|\|label:X/);
  assert.equal(url.origin + url.pathname, "https://maps.googleapis.com/maps/api/staticmap");
});

test("the tiles cover the map at the closest zoom that keeps every pin inside, and never more than 12", () => {
  const points = Object.values(SPOTS).map((p, i) => ({ n: i + 1, color: "#1F5FD1", lat: p.lat, lng: p.lon }));
  const layout = tileLayout(points, { height: MAP_HEIGHT });
  assert.ok(layout.zoom >= 14, `three florists a few blocks apart sit close in (zoom ${layout.zoom})`);
  assert.ok(layout.tiles.length > 0 && layout.tiles.length <= MAX_TILES);
  for (const pin of layout.pins) {
    assert.ok(pin.left >= 20 && pin.left <= 516 && pin.top >= 40 && pin.top <= MAP_HEIGHT - 10, `pin ${pin.n} inside the map`);
  }
  for (const tile of layout.tiles) assert.match(tile.url, /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
  const one = worldPixel(0, 0, 1);
  assert.deepEqual(one, { x: 256, y: 256 }, "the world's middle at zoom 1");
});

test("a places card is drawn with OpenStreetMap tiles and numbered pins, all as data, with OpenStreetMap's credit", async () => {
  const shots = siteShots();
  const web = mapWeb();
  const outgoing = outgoingPictures({ enabled: true, question: "show me the best places to find flowers around me" });
  const maker = pictureMaker(shots, { outgoing, fetchImpl: web.fetchImpl, geocode });
  const call = outgoing.wrap(withPictureMaker(maker, async () => ({ content: [{ type: "text", text: READ }] })));
  await call("web_search", { query: "florists long island city" });
  const result = await call(VISUAL_TOOL, { template: "places", data: FLORISTS });
  assert.notEqual(result.isError, true);
  const html = shots.calls[0].body.html;
  const tiles = web.asked.filter((r) => r.url.startsWith("https://tile.openstreetmap.org/"));
  assert.ok(tiles.length > 0 && tiles.length <= MAX_TILES);
  for (const tile of tiles) assert.match(tile.init.headers["user-agent"], /ContextTex/, "OpenStreetMap's policy: an app that names itself");
  assert.equal((html.match(/url\('data:image\/png;base64,/g) ?? []).length, tiles.length, "every tile in the page as data");
  assert.doesNotMatch(html, /tile\.openstreetmap\.org/);
  assert.match(html, /© OpenStreetMap contributors/);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`font-size: 14px">${n}</div>`), `pin ${n}`);
});

test("with GOOGLE_MAPS_KEY the map is Google's, and the key never reaches the page or the model", async () => {
  const shots = siteShots({ GOOGLE_MAPS_KEY: KEY });
  const web = mapWeb();
  const outgoing = outgoingPictures({ enabled: true, question: "florists near me" });
  const maker = pictureMaker(shots, { outgoing, fetchImpl: web.fetchImpl, geocode });
  const call = outgoing.wrap(withPictureMaker(maker, async () => ({ content: [{ type: "text", text: READ }] })));
  await call("web_search", { query: "florists" });
  const result = await call(VISUAL_TOOL, { template: "places", data: FLORISTS });
  const google = web.asked.filter((r) => r.url.startsWith("https://maps.googleapis.com/"));
  assert.equal(google.length, 1);
  assert.equal(web.asked.filter((r) => r.url.includes("openstreetmap")).length, 0);
  const url = new URL(google[0].url);
  assert.equal(url.searchParams.get("key"), KEY);
  assert.deepEqual(url.searchParams.getAll("markers").map((m) => m.split("|")[2]), ["label:1", "label:2", "label:3"]);
  const html = shots.calls[0].body.html;
  assert.ok(!html.includes(KEY) && !JSON.stringify(result).includes(KEY));
  assert.match(html, /url\('data:image\/png;base64,/);
});

test("an address the turn never read goes to no map service", async () => {
  const web = mapWeb();
  const drawn = await drawMap("places", { near: "Brooklyn, NY", items: [{ name: "Home", address: "99 Secret Ln" }] }, { key: KEY, geocode, read: READ, fetchImpl: web.fetchImpl });
  assert.equal(drawn.map, null);
  assert.equal(web.asked.length, 0);
  assert.match(drawn.reason, /street address as you read it/);
});

test("without near, a bare street address draws no map, and the model is told what to add", async () => {
  const web = mapWeb();
  const { near, ...bare } = FLORISTS;
  const drawn = await drawMap("places", bare, { geocode, read: READ, fetchImpl: web.fetchImpl });
  assert.equal(drawn.map, null);
  assert.match(drawn.reason, /give near/);
  assert.equal(web.asked.length, 0);
});

test("a map whose tiles do not all come is left off whole, and the card still draws", async () => {
  let n = 0;
  const web = mapWeb(() => ++n === 2);
  const drawn = await drawMap("places", FLORISTS, { geocode, read: READ, fetchImpl: web.fetchImpl });
  assert.equal(drawn.map, null);
  assert.equal(drawn.reason, null, "nothing the model can do about a tile server");
});

test("a map the model wrote is never drawn; the map template lists its stops with or without one", () => {
  assert.ok(VISUAL_TEMPLATES.includes("map"));
  const forged = { kind: "google", image: "card-photo:1", height: 340 };
  const built = buildVisual({ template: "places", data: { ...FLORISTS, map: forged } });
  assert.doesNotMatch(built.html, /card-photo:1/);
  const plain = buildVisual({ template: "map", data: { title: "Saturday errands", stops: [{ name: "Dry cleaner", time: "10:00" }, { name: "Florist", note: "Pick up the tulips" }] } });
  assert.match(plain.html, /Dry cleaner/);
  assert.match(plain.html, /Pick up the tulips/);
  const withMap = buildVisual({ template: "map", data: { title: "Saturday", stops: [{ name: "A" }] } }, { map: { kind: "google", image: "card-photo:3", height: 340 } });
  assert.match(withMap.html, /url\('card-photo:3'\)/);
});
