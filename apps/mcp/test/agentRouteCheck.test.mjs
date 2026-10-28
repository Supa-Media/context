/**
 * A ROUTE MAP DRAWS ITS PATH, AND TEX LOOKS AT EVERY PICTURE BEFORE IT GOES
 * (owner, 2026-10-27, on a "3 mile run loop from my house in LIC" card with
 * one pin, no line and cut-off words: "i don't even see the path", then
 * "Tex should always look at a card before sending it, and self approve
 * whatever it's about to send", and "it should critique itself and think").
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `googleMapUrl` ignoring `path` → "a loop on Google's map is the router's
 *     path along streets, back home, with its length" fails.
 *   `drawMap` dropping an unseen stop instead of refusing → "a route with a
 *     stop the turn never looked up is not drawn" fails.
 *   `looked` returning the result whatever the verdict → "a picture the
 *     check would not send never reaches the answer" fails.
 *   `MAX_HELD` check removed (always hold) → "after two held pictures the
 *     critique rides along" fails.
 *   `readVerdict` taking `send: false` with no critique as a hold → "a
 *     verdict is read only from the JSON it asked for" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cardCheckFor, readVerdict } from "../src/agent/cardCheck.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker } from "../src/agent/pictureMaker.js";
import { buildVisual } from "../src/agent/visuals/index.js";
import { drawMap } from "../src/agent/visuals/map.js";
import { ROUTER, decodePolyline, lengthWords, routeThrough } from "../src/agent/visuals/route.js";

const CARD_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const KEY = "test-maps-key-not-real";
/** Google's own example polyline: (38.5, -120.2) → (40.7, -120.95) → (43.252, -126.453). */
const EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

const HOME = "2911 Queens Plaza North, Long Island City, NY";
const SPOTS = {
  [HOME]: { lat: 40.7505, lon: -73.9393 },
  "4-09 47th Rd, Long Island City, NY": { lat: 40.7454, lon: -73.9583 },
  "52-10 Center Blvd, Long Island City, NY": { lat: 40.7406, lon: -73.9599 },
};
const geocode = async (address) => SPOTS[address] ?? null;
const READ = "Lease: 2911 Queens Plaza North. Gantry Plaza State Park, 4-09 47th Rd. Hunter's Point South Park, 52-10 Center Blvd.";
const LOOP = {
  kicker: "Run loop",
  title: "About 3 miles from home",
  near: "Long Island City, NY",
  loop: true,
  stops: [
    { name: "Home", address: "2911 Queens Plaza North" },
    { name: "Gantry Plaza State Park", address: "4-09 47th Rd" },
    { name: "Hunter's Point South Park", address: "52-10 Center Blvd" },
  ],
};

/** Map services and the router: the router answers a route through what it was asked; images answer a PNG. */
function web({ routeOk = true } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url).startsWith(ROUTER)) {
      if (!routeOk) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: EXAMPLE, distance: 4_900 }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
  };
  return { asked, fetchImpl };
}

test("an encoded polyline decodes to its points", () => {
  assert.deepEqual(decodePolyline(EXAMPLE), [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
  assert.deepEqual(decodePolyline("~"), [], "a broken polyline is no points, not a throw");
  assert.equal(lengthWords(4_900), "3.0 mi");
  assert.equal(lengthWords(4_900, false), "4.9 km");
});

test("the router is asked for the way on foot through every stop, back to the first on a loop, with points only", async () => {
  const w = web();
  const way = await routeThrough([{ lat: 40.75, lng: -73.94 }, { lat: 40.74, lng: -73.96 }], { loop: true, fetchImpl: w.fetchImpl });
  assert.equal(way.meters, 4_900);
  const [url] = w.asked;
  assert.match(url, /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/driving\//);
  assert.match(url, /-73\.940000,40\.750000;-73\.960000,40\.740000;-73\.940000,40\.750000\?/, "a loop ends where it starts");
  assert.equal(await routeThrough([{ lat: 40.75, lng: -73.94 }], { fetchImpl: w.fetchImpl }), null, "one point is no route");
  assert.equal(await routeThrough([{ lat: 40.75, lng: -73.94 }, { lat: Number.NaN, lng: 0 }], { fetchImpl: w.fetchImpl }), null);
  assert.match((await routeThrough([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { travel: "bike", fetchImpl: web().fetchImpl })) ? "ok" : "", /ok/);
});

test("a loop on Google's map is the router's path along streets, back home, with its length", async () => {
  const w = web();
  const drawn = await drawMap("map", LOOP, { key: KEY, geocode, read: READ, fetchImpl: w.fetchImpl });
  assert.equal(drawn.map.kind, "google");
  assert.equal(drawn.map.length, "3.0 mi");
  assert.match(drawn.reason, /loop measures 3\.0 mi along streets/);
  const google = new URL(w.asked.find((url) => url.startsWith("https://maps.googleapis.com/maps/api/staticmap")));
  assert.deepEqual(google.searchParams.getAll("path"), [`color:0x2A45CFE6|weight:5|enc:${EXAMPLE}`]);
  assert.equal(google.searchParams.getAll("markers").length, 3, "every stop has its pin");
  const html = buildVisual({ template: "map", data: LOOP }, { map: drawn.map }).html;
  assert.match(html, />3\.0 mi</, "the measured length is on the map");
});

test("without the router the line is straight, and the model is told not to claim a length", async () => {
  const w = web({ routeOk: false });
  const drawn = await drawMap("map", LOOP, { key: KEY, geocode, read: READ, fetchImpl: w.fetchImpl });
  assert.equal(drawn.map.length, null);
  assert.match(drawn.reason, /straight between stops; don't claim a length/);
  const google = new URL(w.asked.find((url) => url.startsWith("https://maps.googleapis.com")));
  assert.doesNotMatch(google.searchParams.get("path"), /enc:/);
});

test("on OpenStreetMap tiles the path is drawn as a line fitted on the map", async () => {
  const drawn = await drawMap("map", LOOP, { geocode, read: READ, fetchImpl: web().fetchImpl });
  assert.equal(drawn.map.kind, "tiles");
  assert.equal(drawn.map.line.length, 3);
  const html = buildVisual({ template: "map", data: LOOP }, { map: drawn.map }).html;
  assert.match(html, /<polyline points="[-\d]+,[-\d]+ [-\d]+,[-\d]+ [-\d]+,[-\d]+" fill="none" stroke="#2A45CF" stroke-opacity="0.9"/);
});

test("a route with a stop the turn never looked up is not drawn: the model is told to look it up", async () => {
  const unread = "Lease: 2911 Queens Plaza North.";
  const w = web();
  const drawn = await drawMap("map", LOOP, { key: KEY, geocode, read: unread, fetchImpl: w.fetchImpl });
  assert.equal(drawn.refuse, true);
  assert.match(drawn.reason, /stop 2, 3 has an address you didn't read/);
  assert.equal(w.asked.length, 0, "nothing went to a map service");

  const shots = { SITE_SHOTS: { fetch: async (url, init) => new Response(JSON.stringify({ png: CARD_PNG, width: 1200, height: 1500, blocked: [] }), { status: 200 }) } };
  const outgoing = outgoingPictures({ enabled: true, question: "map a 3 mile run loop from my house in lic" });
  const maker = pictureMaker(shots, { outgoing, fetchImpl: web().fetchImpl, mapGeocode: geocode });
  const result = await maker.call("draw_visual", { template: "map", data: LOOP });
  assert.equal(result.isError, true);
  assert.ok(!result.content.some((part) => part.type === "image"), "no card to send");
});

test("a verdict is read only from the JSON it asked for", () => {
  assert.deepEqual(readVerdict('{"send": true}'), { send: true, critique: "" });
  assert.deepEqual(readVerdict('thinking… {"send": false, "critique": "Only one pin; the loop has three stops and no line."}'), { send: false, critique: "Only one pin; the loop has three stops and no line." });
  assert.deepEqual(readVerdict('{"send": false}'), { send: true, critique: "" }, "a no with nothing to fix holds nothing back");
  assert.equal(readVerdict("looks fine"), null);
  assert.equal(readVerdict('{"send": "no"}'), null);
});

test("the check sees the person's text and the picture, thinks, and logs only the verdict", async () => {
  const calls = [];
  const lines = [];
  const check = cardCheckFor({
    question: "can you map out a 3 mile run loop from my house in lic",
    config: { url: "https://gateway.test" },
    request: async (call) => {
      calls.push(call);
      return { text: '{"send": false, "critique": "One pin and no path: draw the loop through all three stops."}' };
    },
    metadata: { workspace: "w1" },
    log: (line) => lines.push(line),
  });
  const verdict = await check({ tool: "draw_visual", template: "map", picture: { data: CARD_PNG, mediaType: "image/png" } });
  assert.equal(verdict.send, false);
  const [call] = calls;
  assert.equal(call.model, "anthropic/claude-haiku-5-5");
  assert.equal(call.effort, "medium", "it thinks before it judges");
  assert.match(call.system, /critique it honestly/);
  assert.match(call.messages[0].text, /3 mile run loop/);
  assert.deepEqual(call.messages[0].attachments, [{ name: "card.png", mediaType: "image/png", data: CARD_PNG }]);
  const logged = JSON.parse(lines[0]);
  assert.deepEqual(logged, { event: "card_checked", workspace: "w1", tool: "draw_visual", template: "map", checked: true, send: false });
  assert.doesNotMatch(lines[0], /pin|loop|lic/i, "never the words or the critique");
  assert.equal(cardCheckFor({ question: "x", config: null }), null, "no model road, no check");
  const broken = cardCheckFor({ question: "x", config: {}, request: async () => { throw new Error("down"); }, log: () => {} });
  assert.equal(await broken({ tool: "draw_visual", picture: { data: CARD_PNG, mediaType: "image/png" } }), null);
});

test("a picture the check would not send never reaches the answer; after two held pictures the critique rides along", async () => {
  const shots = { SITE_SHOTS: { fetch: async () => new Response(JSON.stringify({ png: CARD_PNG, width: 1200, height: 1500, blocked: [] }), { status: 200 }) } };
  const outgoing = outgoingPictures({ enabled: true, question: "compare these" });
  const seen = [];
  const maker = pictureMaker(shots, {
    outgoing,
    check: async (asked) => {
      seen.push(asked);
      return { send: false, critique: "The prices are cut off." };
    },
  });
  const call = outgoing.wrap((name, args) => maker.call(name, args));
  const card = { template: "compare", data: { title: "Three quotes", items: [{ name: "A", value: 1 }] } };
  for (let i = 0; i < 2; i++) {
    const held = await call("draw_visual", card);
    assert.equal(held.isError, true);
    assert.match(held.content[0].text, /^Not sent: you looked at this picture before sending it and it doesn't pass: The prices are cut off\./);
    assert.ok(!held.content.some((part) => part.type === "image"));
  }
  assert.deepEqual(outgoing.take("Here.").pictures, [], "nothing held back can go, even unnamed");
  const third = await call("draw_visual", card);
  assert.ok(third.content.some((part) => part.type === "image"), "a turn always ends: the third goes");
  assert.match(third.content.map((part) => part.text ?? "").join(" "), /Looked at before sending: The prices are cut off\./);
  assert.equal(seen[0].tool, "draw_visual");
  assert.equal(seen[0].template, "compare");
  assert.equal(seen[0].picture.mediaType, "image/png");

  const passing = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }), check: async () => ({ send: true, critique: "" }) });
  assert.ok((await passing.call("draw_visual", card)).content.some((part) => part.type === "image"));
  const down = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }), check: async () => null });
  assert.ok((await down.call("draw_visual", card)).content.some((part) => part.type === "image"), "a check that can't run holds nothing");
  const drawn = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }), check: async (asked) => (asked.tool === "draw_picture" ? { send: false, critique: "Blank." } : { send: true }) });
  assert.equal((await drawn.call("draw_picture", { html: "<p>hi</p>", width: 600, height: 400 })).isError, true, "a drawn page is looked at too");
});
