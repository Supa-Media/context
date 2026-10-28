/**
 * A PAGE'S OPTIONS SHOW THEIR PICTURES TOO (owner, 2026-10-27: comparisons
 * "need to show screenshots of the things PLEASE"; every new note is a page).
 * A texted turn's page write has each place, vote option, price or stop with
 * no photo hunted for (`agent/visuals/pagePhotos.js`, by `visuals/hunt.js`),
 * the picture put in the write's images and a `photo:` field under it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `withPagePictures` returning the args untouched → "a place with no photo
 *     gets one" and "through the picture tools" fail.
 *   The `photo:` line written without the extra indent → "a place with no
 *     photo gets one" fails (the field becomes a block setting).
 *   `storableImage`'s check skipped → "a picture the write could not store is
 *     left out" fails (2026-10-28).
 *   `pageWrite` not writing again as sent when refused with pictures → "a page
 *     write refused with the pictures found is written again" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { STORABLE_ACCEPT, storableDownload, unpictured, withPagePictures } from "../src/agent/visuals/pagePhotos.js";

const PAGE = [
  "---",
  "kind: research",
  "skill: pages-test",
  "---",
  "# Dinner in Chelsea",
  "",
  "```places Three to try",
  "- Hav and Mar: 245 Eleventh Ave | Ethiopian and Nordic",
  "  price: $$",
  "- Shukette: 230 9th Ave | Middle Eastern",
  "- Markette: 64 W 10th St | Modern European",
  "  photo: markette.jpg",
  "```",
  "",
].join("\n");

/** The turn's web tools: a picture search answers from `pictures`, by query. */
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

const download = async (address) => (address.includes("broken") ? null : "data:image/jpeg;base64,/9j/4A==");

/** The fields under each option of the page's first block. */
function fieldsOf(content) {
  const block = parsePage(content).nodes.find((node) => node.type === "block");
  return block.items.map((item) => Object.fromEntries(item.fields.map((field) => [field.key, field.value.text])));
}

test("the options wanting a picture are those in a pictured block with no photo field", () => {
  assert.deepEqual(
    unpictured(PAGE).map((option) => [option.name, option.query]),
    [
      ["Hav and Mar", "Hav and Mar 245 Eleventh Ave"],
      ["Shukette", "Shukette 230 9th Ave"],
    ],
  );
});

test("a place with no photo gets one: a photo field under it and the picture in the write's images", async () => {
  const w = web({ "Shukette 230 9th Ave": [["Shukette dining room", "https://cdn.example/shukette.jpg"]] });
  const { args, found } = await withPagePictures({ path: "projects/dinner.page.md", content: PAGE, images: [] }, { web: w.call, download });
  assert.deepEqual(found, ["Shukette"]);
  assert.deepEqual(args.images, [{ name: "shukette-1.jpg", data: "data:image/jpeg;base64,/9j/4A==" }]);
  assert.deepEqual(fieldsOf(args.content), [{ price: "$$" }, { photo: "shukette-1.jpg" }, { photo: "markette.jpg" }]);
  assert.deepEqual(parsePage(args.content).problems, [], "the page still draws");
  assert.equal(args.content.replace("\n  photo: shukette-1.jpg", ""), PAGE, "nothing else changed");
});

test("a place's picture is the screenshot of its own page when no picture search finds one", async () => {
  const read = () => "1. Hav and Mar - Chelsea restaurant - https://havandmar.example/";
  const shot = [];
  const shoot = async (url) => (shot.push(url), "data:image/jpeg;base64,/9j/4A==");
  const { args } = await withPagePictures({ path: "dinner.page.md", content: PAGE }, { web: web().call, download, shoot, read });
  assert.deepEqual(shot, ["https://havandmar.example/"]);
  assert.equal(fieldsOf(args.content)[0].photo, "hav-and-mar-1.jpg");
});

test("a plain note, a page with every photo, or a write with no room for more pictures is left as it was", async () => {
  const w = web({ "Shukette 230 9th Ave": [["Shukette", "https://cdn.example/shukette.jpg"]] });
  const plain = { path: "notes/dinner.md", content: PAGE };
  assert.equal((await withPagePictures(plain, { web: w.call, download })).args, plain);
  const full = { path: "dinner.page.md", content: PAGE, images: Array.from({ length: 10 }, (_, i) => ({ name: `p${i}.jpg`, data: "x" })) };
  assert.equal((await withPagePictures(full, { web: w.call, download })).args, full);
  assert.equal(w.calls.length, 0);
});

test("nothing found leaves the page's words exactly as written", async () => {
  const args = { path: "dinner.page.md", content: PAGE };
  const out = await withPagePictures(args, { web: web().call, download });
  assert.equal(out.args, args);
});

test("through the picture tools, a texted turn's page write is saved with the pictures and says so", async () => {
  const outgoing = outgoingPictures({ enabled: true, question: "dinner options in chelsea, make me a page" });
  const maker = pictureMaker({ SITE_SHOTS: { fetch: async () => Response.json({ shots: [] }) } }, { outgoing, fetchImpl: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } }) });
  const w = web({ "Hav and Mar 245 Eleventh Ave": [["Hav and Mar", "https://cdn.example/havmar.jpg"]] });
  maker.useWeb(w.call);
  assert.equal(maker.has("write_note"), true);
  const saved = [];
  const call = withPictureMaker(maker, async (name, args) => (saved.push({ name, args }), { content: [{ type: "text", text: "Saved." }] }));
  const result = await call("write_note", { path: "dinner.page.md", content: PAGE });
  assert.equal(saved.length, 1);
  assert.equal(fieldsOf(saved[0].args.content)[0].photo, "hav-and-mar-1.jpg");
  assert.match(saved[0].args.images[0].data, /^data:image\/jpeg;base64,/);
  assert.match(result.content.at(-1).text, /Pictures found and added to the page for: Hav and Mar/);
});

// An AVIF's first bytes (`ftypavif`) and an SVG: both download as pictures, and a note write refuses both.
const AVIF = `data:image/avif;base64,${btoa("\0\0\0\x1cftypavif\0\0\0\0avifmif1")}`;
const SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;

test("a picture the write could not store is left out, so it never refuses the page", async () => {
  const w = web({
    "Hav and Mar 245 Eleventh Ave": [["Hav and Mar", "https://cdn.example/havmar.avif"]],
    "Shukette 230 9th Ave": [["Shukette", "https://cdn.example/shukette.svg"]],
  });
  const fetched = { "https://cdn.example/havmar.avif": AVIF, "https://cdn.example/shukette.svg": SVG };
  const args = { path: "dinner.page.md", content: PAGE };
  const out = await withPagePictures(args, { web: w.call, download: async (address) => fetched[address] ?? null });
  assert.equal(out.args, args, "nothing it could not store went in");
  assert.deepEqual(out.found, []);
});

test("a shot labelled JPEG goes in as the type its bytes are", async () => {
  const png = `data:image/jpeg;base64,${btoa("\x89PNG\r\n\x1a\n\0\0\0\0")}`;
  const read = () => "1. Shukette - Chelsea restaurant - https://shukette.example/";
  const { args } = await withPagePictures({ path: "dinner.page.md", content: PAGE }, { web: web().call, download, shoot: async () => png, read });
  assert.equal(args.images.length, 1);
  assert.match(args.images[0].data, /^data:image\/png;base64,/);
  assert.equal(args.images[0].name, "shukette-1.png");
});

test("a page write refused with the pictures found is written again as it was sent", async () => {
  const outgoing = outgoingPictures({ enabled: true, question: "dinner options in chelsea, make me a page" });
  const maker = pictureMaker({ SITE_SHOTS: { fetch: async () => Response.json({ shots: [] }) } }, { outgoing, fetchImpl: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } }) });
  maker.useWeb(web({ "Hav and Mar 245 Eleventh Ave": [["Hav and Mar", "https://cdn.example/havmar.jpg"]] }).call);
  const saved = [];
  const call = withPictureMaker(maker, async (name, args) => {
    saved.push(args);
    return args.images?.length ? { content: [{ type: "text", text: "images[0]: not a picture" }], isError: true } : { content: [{ type: "text", text: "Saved." }] };
  });
  const result = await call("write_note", { path: "dinner.page.md", content: PAGE });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].content, PAGE, "the second write is the page as written");
  assert.equal(saved[1].images, undefined);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Saved/);
});

test("a page's picture is asked for in a stored format, and one that comes as AVIF is photographed as a JPEG", async () => {
  const asked = [];
  const jpeg = "data:image/jpeg;base64,/9j/4A==";
  const fetched = { "https://cdn.example/a.jpg": jpeg, "https://cdn.example/b.avif": AVIF, "https://cdn.example/c.svg": SVG };
  const download = async (address, headers) => (asked.push([address, headers.accept]), fetched[address] ?? null);
  const shot = [];
  const get = storableDownload(download, async (address) => (shot.push(address), address.endsWith(".svg") ? null : jpeg));
  assert.equal(await get("https://cdn.example/a.jpg"), jpeg);
  assert.equal(await get("https://cdn.example/b.avif"), jpeg, "the AVIF comes back as the browser's JPEG of it");
  assert.equal(await get("https://cdn.example/c.svg"), null, "nothing storable: the hunt tries its next way");
  assert.equal(await get("https://cdn.example/missing.jpg"), null);
  assert.deepEqual(shot, ["https://cdn.example/b.avif", "https://cdn.example/c.svg"], "only what a note can't store is photographed");
  assert.ok(asked.every(([, accept]) => accept === STORABLE_ACCEPT && !/avif|svg/.test(accept)));
});
