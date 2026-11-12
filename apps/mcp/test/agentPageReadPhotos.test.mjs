/**
 * PICTURES ON RESEARCH PAGES (Nov Babies, 2026-11-11: "put pictures in your
 * research"; both research pages went out with no picture on an option).
 *
 * Three causes, each pinned here:
 *   - a page named photos it never attached (`photo: kims-cover.png`), and
 *     the hunt skipped any option with a photo field, so nothing filled them
 *     (`withoutDeadPhotos`, `heldPicture` in `agent/visuals/pagePhotos.js`);
 *   - a photo address Tex read went to the sharing judge as a fetch from
 *     outside, and was refused (`agent/visuals/pageReadImages.js`). An address
 *     the turn never read is still judged;
 *   - a card item with no photo was a blank block (`photo()` in
 *     `agent/visuals/kit.js` is now a "No photo found" tile).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `heldPicture` answering true for every name → "a photo name with nothing
 *     behind it is taken off and hunted" and "through the picture tools, a
 *     dead photo name is hunted" fail.
 *   `withReadImages` treating every address as read → "an address the turn
 *     never read stays an address, so the judge still reads it" fails.
 *   `withReadImages` returning the args untouched → "a photo address the
 *     turn read is saved as its bytes, so nothing is judged" fails.
 *   `photo()` drawing the tile under every slot → "a card item with no photo
 *     is a tile that says so" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { heldPicture, withoutDeadPhotos, withPagePictures } from "../src/agent/visuals/pagePhotos.js";
import { withReadImages } from "../src/agent/visuals/pageReadImages.js";
import { wideningOf } from "../src/privacy/widening.js";

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

const PAGE = [
  "---",
  "kind: research",
  "---",
  "# Birthday for 20",
  "",
  "```choose Where we go",
  "- Ms. Kim's: Korean dinner and karaoke | $52 a person",
  "  photo: kims-cover.png",
  "- Muses 35: karaoke rooms | $60 a person",
  "  photos: muses-cover.png, upload-0123456789abcdef.jpg",
  "- Frames: bowling | $45 a person",
  "  photo: frames.jpg",
  "```",
  "",
].join("\n");

const fieldsOf = (content) =>
  parsePage(content)
    .nodes.find((node) => node.type === "block")
    .items.map((item) => Object.fromEntries(item.fields.map((field) => [field.key, field.value.text])));

function web(pictures = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    const found = pictures[args.query] ?? [];
    if (args.pictures === true) {
      return { content: [{ type: "text", text: ["These are picture search results.", `Picture search: ${args.query}`, "", found.length ? `Pictures found:\n${found.map(([alt, src]) => `- ${alt} - ${src}`).join("\n")}` : "(no pictures)"].join("\n") }] };
    }
    return { content: [{ type: "text", text: "These are web search results.\n\n(no results)" }] };
  };
  return { calls, call };
}

test("a photo name counts only when something is behind it", () => {
  const attached = new Set(["frames.jpg"]);
  assert.equal(heldPicture("frames.jpg", attached), true, "attached in this write");
  assert.equal(heldPicture("upload-0123456789abcdef.jpg", attached), true, "a picture the note stores");
  assert.equal(heldPicture("https://cdn.example/a.jpg", attached), true, "an address is not judged here");
  assert.equal(heldPicture("kims-cover.png", attached), false);
  assert.equal(heldPicture("", attached), false);
});

test("a photo name with nothing behind it is taken off and hunted; a real one stays", () => {
  const { content, dead } = withoutDeadPhotos(PAGE, new Set(["frames.jpg"]));
  assert.deepEqual(fieldsOf(content), [{}, { photos: "upload-0123456789abcdef.jpg" }, { photo: "frames.jpg" }]);
  assert.deepEqual(dead, [
    { option: "Ms. Kim's", names: ["kims-cover.png"] },
    { option: "Muses 35", names: ["muses-cover.png"] },
  ]);
  assert.deepEqual(parsePage(content).problems, [], "the page still draws");
});

test("the hunt fills an option whose only photo name was dead", async () => {
  const w = web({ "Ms. Kim's Korean dinner and karaoke": [["Ms. Kim's", "https://cdn.example/kims.jpg"]] });
  const { args, found, dead } = await withPagePictures({ path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", data: JPEG }] }, { web: w.call, download: async () => JPEG });
  assert.deepEqual(found, ["Ms. Kim's"]);
  assert.equal(dead.length, 2);
  assert.equal(fieldsOf(args.content)[0].photo, "ms-kim-s-1.jpg");
  assert.ok(args.images.some((image) => image.name === "ms-kim-s-1.jpg"));
});

test("nothing found still takes the dead names off, so no broken picture shows", async () => {
  const { args } = await withPagePictures({ path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", data: JPEG }] }, { web: web().call, download: async () => null });
  assert.doesNotMatch(args.content, /kims-cover|muses-cover/);
  assert.match(args.content, /frames\.jpg/);
});

test("a photo address the turn read is saved as its bytes, so nothing is judged", async () => {
  const write = { path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", url: "https://frames.example/lanes.jpg", alt: "Lanes" }] };
  const { args, kept } = await withReadImages(write, { vouches: (address) => address === "https://frames.example/lanes.jpg", download: async () => JPEG });
  assert.deepEqual(kept, ["frames.jpg"]);
  assert.deepEqual(args.images, [{ name: "frames.jpg", alt: "Lanes", data: JPEG }]);
  assert.equal(await wideningOf("write_note", args, { privacy: async () => ({ rules: [], overrides: [] }) }), null, "no fetch from outside is left to judge");
});

test("an address the turn never read stays an address, so the judge still reads it", async () => {
  const write = { path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", url: "https://evil.example/x.jpg?q=secret" }] };
  const { args } = await withReadImages(write, { vouches: () => false, download: async () => JPEG });
  assert.equal(args, write);
  const widening = await wideningOf("write_note", args, { privacy: async () => ({ rules: [], overrides: [] }) });
  assert.equal(widening?.audience, "outside");
  assert.match(widening.summary, /fetch an image from evil\.example/);
});

test("a read address that gives no storable picture is dropped, and its name is hunted", async () => {
  const write = { path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", url: "https://frames.example/dead.jpg" }] };
  const { args, dropped } = await withReadImages(write, { vouches: () => true, download: async () => null });
  assert.deepEqual(dropped, ["frames.jpg"]);
  assert.deepEqual(args.images, []);
});

test("through the picture tools, a page write gets read photos as bytes, dead names hunted, and an answer that says so", async () => {
  const lanes = "https://frames.example/lanes.jpg";
  const outgoing = outgoingPictures({ enabled: true, question: "put pictures in your research" });
  const fetchImpl = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
  const maker = pictureMaker({ SITE_SHOTS: { fetch: async () => Response.json({ shots: [] }) } }, { outgoing, fetchImpl });
  const w = web({ "Ms. Kim's Korean dinner and karaoke": [["Ms. Kim's", "https://cdn.example/kims.jpg"]] });
  // The turn opened Frames' page, which showed this picture.
  await outgoing.wrapWeb({ call: async () => ({ content: [{ type: "text", text: `Frames Bowl ${lanes}` }] }) }).call("open_page", { url: "https://frames.example/" });
  maker.useWeb(w.call);
  const saved = [];
  const call = withPictureMaker(maker, async (name, args) => (saved.push(args), { content: [{ type: "text", text: "Saved." }] }));
  const result = await call("write_note", { path: "plan.page.md", content: PAGE, images: [{ name: "frames.jpg", url: lanes }] });
  assert.equal(saved.length, 1);
  assert.ok(saved[0].images.every((image) => image.url === undefined), "no address left for the judge");
  assert.equal(fieldsOf(saved[0].content)[0].photo, "ms-kim-s-1.jpg");
  const said = result.content.map((part) => part.text).join("\n");
  assert.match(said, /Photos saved from addresses you read: frames\.jpg/);
  assert.match(said, /not attached to the write.*Ms\. Kim's \(kims-cover\.png\)/);
  assert.match(said, /Pictures found and added to the page for: Ms\. Kim's/);
});

test("a card item with no photo is a tile that says so, never a blank block; one with a photo shows no tile", async () => {
  const { gallery, versus } = await import("../src/agent/visuals/choices.js");
  const html = gallery({ title: "Karaoke for 20", items: [{ name: "Ms. Kim's", price: "$52" }, { name: "Muses 35", price: "$60", photo: "card-photo:1" }] });
  const text = typeof html === "string" ? html : JSON.stringify(html);
  assert.equal((text.match(/data-no-photo/g) ?? []).length, 1, "only the item with no photo");
  assert.match(text, /data-no-photo[^>]*>.*Ms\. Kim&#39;s.*No photo found/s);
  const both = versus({ title: "A or B", items: [{ name: "Frames" }, { name: "Bowlero" }], rows: [] });
  assert.equal(((typeof both === "string" ? both : JSON.stringify(both)).match(/data-no-photo/g) ?? []).length, 2);
});
