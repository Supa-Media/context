/**
 * TEX TEXTS PICTURES BACK (owner, 2026-10-16: "Tex says he can't send
 * pictures by text, can you fix that?").
 *
 * A texted answer may name pictures, one per line: `[picture N]` for one a
 * tool showed this turn, `[picture https://…]` for an image on the web whose
 * address was read this turn. The lines leave the answer and the `/agent`
 * response carries them as `pictures` for the texting Worker to send.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `take` accepting any https address → "an address the turn never read is
 *     not fetched for it" fails.
 *   route.js not wrapping the dispatcher with `outgoing.wrap` → "a picture
 *     read from their notes is texted back" fails (no picture 1 exists).
 *   `PICTURES_LINE` left out of the texting prompt → "a texted turn is told
 *     it can send pictures" fails.
 *   `wrap` keeping a result's words whole → "a tool repeating what the model
 *     gave it does not vouch the address in it" fails.
 *   `withoutGiven` cutting an address that merely starts with one given →
 *     "an address read before the model used it stays vouched when a tool
 *     repeats it" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DATA_CARDS_LINE, MAX_PICTURES, PICTURES_LINE, outgoingPictures } from "../src/agent/outgoingPictures.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image = (data = PNG) => ({ type: "image", data, mimeType: "image/png" });

test("a picture a tool showed is numbered, and its line names it", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const call = outgoing.wrap(async () => ({ content: [{ type: "text", text: "image: x" }, image()] }));
  const result = await call("read_image", {});
  assert.match(result.content.at(-1).text, /This is picture 1: to text it to them, write \[picture 1\]/);
  const { answer, pictures } = outgoing.take("Here it is.\n[picture 1]\n[picture 7]");
  assert.equal(answer, "Here it is.");
  assert.deepEqual(pictures, [{ name: "picture-1.png", mediaType: "image/png", data: PNG }], "an unknown number sends nothing");
});

test("a picture named mid-sentence is still sent, and the marker never reaches them", async () => {
  // Dev, 2026-10-19: "Here's a draft with made-up details: ... location TBA. [picture 1]"
  // arrived as that text, with no poster.
  const outgoing = outgoingPictures({ enabled: true });
  await outgoing.wrap(async () => ({ content: [image()] }))("draw_picture", {});
  const { answer, pictures } = outgoing.take("Here's a draft: Sunday, 2 to 5 pm, location TBA. [picture 1]\nTell me the real place.");
  assert.equal(answer, "Here's a draft: Sunday, 2 to 5 pm, location TBA.\nTell me the real place.");
  assert.equal(pictures.length, 1);
});

test("an address the turn never read is not fetched for it", async () => {
  const outgoing = outgoingPictures({ enabled: true, question: "send me https://example.com/cat.jpg" });
  const call = outgoing.wrap(async () => ({ content: [{ type: "text", text: "Found https://images.example.org/dog.png" }] }));
  await call("search", {});
  const { answer, pictures } = outgoing.take(
    [
      "Here you go.",
      "[picture https://example.com/cat.jpg]",
      "[picture https://images.example.org/dog.png]",
      "[picture https://evil.example/?q=their-address]",
      "[picture http://images.example.org/dog.png]",
    ].join("\n"),
  );
  assert.equal(answer, "Here you go.");
  assert.deepEqual(pictures, [{ url: "https://example.com/cat.jpg" }, { url: "https://images.example.org/dog.png" }]);
});

test("at most eight pictures (a set of option cards), each once, and a turn not from a phone is untouched", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const call = outgoing.wrap(async () => ({ content: Array.from({ length: 9 }, () => image()) }));
  await call("read_image", {});
  const lines = ["[picture 1]", "[picture 1]", ...Array.from({ length: 8 }, (_, i) => `[picture ${i + 2}]`)].join("\n");
  assert.equal(MAX_PICTURES, 8);
  assert.equal(outgoing.take(lines).pictures.length, MAX_PICTURES);

  const off = outgoingPictures({ enabled: false });
  const raw = { content: [image()] };
  assert.equal(await off.wrap(async () => raw)("read_image", {}), raw);
  assert.deepEqual(off.take("a\n[picture 1]"), { answer: "a\n[picture 1]", pictures: [] });
});

test("a picture read from their notes is texted back", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([
      {
        toolCalls: [
          {
            name: "write_note",
            args: {
              path: "1-projects/frog.md",
              content: "# Frog\n\n![[frog.png]]\n",
              images: [{ name: "frog.png", data: `data:image/png;base64,${PNG}` }],
            },
          },
        ],
      },
      { text: "Saved." },
    ]);
    const saved = await request(world.env, TOKEN_TEXTS, "/agent", { question: "save a frog as a plain note", conversation: "texts" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const leaf = world.objectsUnder(".context/assets/images/")[0].split("/").at(-1);

    world.model.install([
      { toolCalls: [{ name: "read_image", args: { note: "1-projects/frog.md", image: leaf } }] },
      { text: "Here's the frog.\n\n[picture 1]" },
    ]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "send me the frog picture", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Here's the frog.");
    assert.equal(asked.body.pictures.length, 1);
    assert.equal(asked.body.pictures[0].mediaType, "image/png");
    assert.match(asked.body.pictures[0].data, /^[A-Za-z0-9+/]{40,}={0,2}$/);
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /This is picture 1/, "the model was told the number");
    const history = world.objectsUnder(".context/").map((key) => String(world.bucket.get(key)?.body ?? "")).join("\n");
    assert.match(history, /Sent a picture with this answer/);
    assert.ok(!history.includes(asked.body.pictures[0].data), "the saved conversation never holds the bytes");
  } finally {
    world.restore();
  }
});

test("a texted turn is told it can send pictures", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Hi." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts" });
    assert.equal(asked.status, 200);
    assert.ok(!("pictures" in asked.body));
    const system = JSON.stringify(world.model.requests.at(-1).system);
    assert.ok(system.includes(PICTURES_LINE.slice(0, 60)), "the prompt says pictures can be sent");
    // Dev, 2026-10-19: "make me a poster for a picnic on sunday" came back as
    // questions about the time and place. A picture is made first, then changed.
    assert.match(system, /Asked for a picture, make one now/);
  } finally {
    world.restore();
  }
});

test("a tool repeating what the model gave it does not vouch the address in it", async () => {
  const outgoing = outgoingPictures({ enabled: true, question: "make me a poster" });
  // Tools restate what they were handed ("there is no X to work from"). That
  // echo is the model's own words coming back, so an address it assembled
  // this turn would otherwise become one "the turn read" and go out carrying
  // whatever the turn had just learnt.
  const call = outgoing.wrap(async (name, args) => ({
    content: [{ type: "text", text: `There is no ${args.from} to work from.` }],
    isError: true,
  }));
  await call("make_picture", { from: "https://e.gg/?d=0415550123" });
  assert.equal(outgoing.vouches("https://e.gg/?d=0415550123"), false);

  // Echoed back shortened, or in another case, it is still the model's.
  const clipped = outgoing.wrap(async (name, args) => ({
    content: [{ type: "text", text: `no such picture: ${String(args.from).slice(0, 26).toUpperCase()}` }],
  }));
  await clipped("make_picture", { from: "https://e.gg/?d=0415550123-and-padding-to-cut" });
  assert.equal(outgoing.vouches("HTTPS://E.GG/?D=0415550123"), false);

  const { pictures } = outgoing.take("Here.\n[picture https://e.gg/?d=0415550123]\n[picture HTTPS://E.GG/?D=0415550123]");
  assert.deepEqual(pictures, []);
});

test("an address read before the model used it stays vouched when a tool repeats it", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const read = outgoing.wrap(async () => ({ content: [{ type: "text", text: "Logo at https://cdn.example.com/logo.png and https://cdn.example.com/dog.png" }] }));
  await read("read_note", {});
  const browsed = outgoing.wrap(async (name, args) => ({ content: [{ type: "text", text: `could not open ${args.url}` }] }));
  await browsed("browse", { url: "https://cdn.example.com/logo.png" });
  assert.equal(outgoing.vouches("https://cdn.example.com/logo.png"), true, "it was read before it was passed");
  assert.equal(outgoing.vouches("https://cdn.example.com/dog.png"), true, "a sibling address the page itself named is untouched");

  const page = outgoing.wrap(async (name, args) => ({ content: [{ type: "text", text: `${args.url} shows https://cdn.example.com/logo.png/large.webp` }] }));
  await page("browse", { url: "https://cdn.example.com/logo.png" });
  assert.equal(outgoing.vouches("https://cdn.example.com/logo.png/large.webp"), true, "what the fetched page named under it is the page's own words");
});

test("option cards sent together carry their choices, so the person can pick with one tap", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const draw = outgoing.wrap(async () => ({ content: [image()] }));
  await draw("draw_visual", { template: "places", data: { title: "Near you" } });
  await draw("draw_visual", { template: "option", data: { index: 1, of: 2, name: "  Via\nCarota ", price: "$$", pick: true } });
  await draw("draw_visual", { template: "option", data: { index: 2, of: 2, name: "Bar Pitti" } });
  const { choices } = outgoing.take("Two good ones.\n[picture 2]\n[picture 3]\n[picture 1]");
  assert.deepEqual(choices, [
    { name: "Via Carota", price: "$$", pick: true, picture: 0 },
    { name: "Bar Pitti", picture: 1 },
  ]);
});

test("one option card, or option cards never sent, offer no choice", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const draw = outgoing.wrap(async () => ({ content: [image()] }));
  await draw("draw_visual", { template: "option", data: { name: "Via Carota" } });
  await draw("draw_visual", { template: "option", data: { name: "Bar Pitti" } });
  assert.deepEqual(outgoing.take("Just this one.\n[picture 1]").choices, []);
  assert.deepEqual(outgoingPictures({ enabled: false }).take("x").choices, undefined);
});

// Tex Devs group, 2026-10-26: draw_visual worked, the answer said "Here's the one-pager" and named no
// [picture N], so the card never went. A card the turn drew goes even when the answer forgot to name it.
test("a drawn card the answer forgot to name still goes; a redrawn one replaces it; option cards go as a set", async () => {
  const image = (data) => async () => ({ content: [{ type: "image", data, mimeType: "image/png" }] });
  const one = outgoingPictures({ enabled: true });
  await one.wrap(image("first"))("draw_visual", { template: "board", data: { title: "v1" } });
  await one.wrap(image("second"))("draw_visual", { template: "board", data: { title: "v2" } });
  const taken = one.take("Here's the one-pager. It's not started.");
  assert.deepEqual(taken.pictures.map((p) => p.data), ["second"]);
  assert.equal(taken.answer, "Here's the one-pager. It's not started.");

  const set = outgoingPictures({ enabled: true });
  for (const [i, name] of ["Lugo's", "Blend", "India Passage"].entries()) {
    await set.wrap(image(`card${i}`))("draw_visual", { template: "option", data: { index: i + 1, of: 3, name } });
  }
  assert.deepEqual(set.take("Lugo's is my pick.").pictures.map((p) => p.data), ["card0", "card1", "card2"]);

  // A picture only read, never drawn, still needs naming; a named one goes as named.
  const read = outgoingPictures({ enabled: true });
  await read.wrap(image("from-note"))("read_image", { path: "a.png" });
  assert.deepEqual(read.take("That's the photo.").pictures, []);
  const named = outgoingPictures({ enabled: true });
  await named.wrap(image("a"))("draw_visual", { template: "board", data: {} });
  await named.wrap(image("b"))("draw_visual", { template: "board", data: {} });
  assert.deepEqual(named.take("Here.\n[picture 1]").pictures.map((p) => p.data), ["a"]);
});

// Dev2, 2026-10-29: a drawn card went as a bare picture and Tex said iMessage cards can only be pictures.
// A drawn card carries its title, so a chat with Context cards gets it as one; an option card does not.
test("a drawn card carries its title for a Context card; an option card and a read picture carry none", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const draw = outgoing.wrap(async () => ({ content: [image()] }));
  await draw("draw_visual", { template: "day", data: { title: "  Team\nlunch " } });
  await draw("draw_visual", { template: "board", data: { kicker: "This week" } });
  await draw("draw_visual", { template: "option", data: { title: "Pick", name: "Via Carota" } });
  await draw("read_image", { path: "a.png" });
  const { pictures } = outgoing.take("[picture 1]\n[picture 2]\n[picture 3]\n[picture 4]");
  assert.deepEqual(pictures.map((p) => p.title), ["Team lunch", "This week", undefined, undefined]);
  assert.match(PICTURES_LINE, /arrives as a Context card on a phone with the Context app/);
  assert.match(PICTURES_LINE, /never tell them a card can only be a picture/);
});

test("an option set the answer forgot to name still carries its choices", async () => {
  const set = outgoingPictures({ enabled: true });
  for (const [i, name] of ["Lugo's", "Blend"].entries()) {
    await set.wrap(async () => ({ content: [image()] }))("draw_visual", { template: "option", data: { index: i + 1, of: 2, name } });
  }
  assert.deepEqual(set.take("Lugo's is my pick.").choices, [{ name: "Lugo's", picture: 0 }, { name: "Blend", picture: 1 }]);
});

test("a card line offers a card on their own data, and never reaches them as words", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "When are you free next week?\n[card times]\n[card times] [card inbox]\n[card pick]" }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "find a lunch slot with Ana", conversation: "texts" });
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.body.offers, ["times", "inbox"]);
    assert.doesNotMatch(asked.body.answer, /\[card (times|inbox)\]/);
    assert.match(asked.body.answer, /^When are you free next week\?/);
    assert.ok(JSON.stringify(world.model.requests.at(-1).system).includes(DATA_CARDS_LINE.slice(0, 60)), "the prompt says how to offer one");

    world.model.install([{ text: "Done." }]);
    const plain = await request(world.env, TOKEN_TEXTS, "/agent", { question: "thanks", conversation: "texts" });
    assert.ok(!("offers" in plain.body));
  } finally {
    world.restore();
  }
});

test("a turn not from a phone keeps a card line as written", () => {
  const off = outgoingPictures({ enabled: false });
  assert.deepEqual(off.take("[card times]"), { answer: "[card times]", pictures: [] });
});
