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
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PICTURES, PICTURES_LINE, outgoingPictures } from "../src/agent/outgoingPictures.js";
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

test("at most four pictures, each once, and a turn not from a phone is untouched", async () => {
  const outgoing = outgoingPictures({ enabled: true });
  const call = outgoing.wrap(async () => ({ content: [image(), image(), image(), image(), image()] }));
  await call("read_image", {});
  const lines = ["[picture 1]", "[picture 1]", "[picture 2]", "[picture 3]", "[picture 4]", "[picture 5]"].join("\n");
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
    const saved = await request(world.env, TOKEN_TEXTS, "/agent", { question: "save a frog", conversation: "texts" });
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
