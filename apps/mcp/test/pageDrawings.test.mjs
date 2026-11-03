/**
 * TEX DRAWS EVERY PAGE THAT HAS NO PICTURE (owner, 2026-11-03: "whenever Tex
 * makes pages, can you have it generate an image representing the page if
 * there is no image already in the page, it should be in tex style"; "Tex
 * draws it in ink"; "use the more calm version of tex ... most people won't
 * be generating images involving Tex").
 *
 * What is pinned:
 *  - the model's scene is read into shapes and written again, so nothing it
 *    writes (a script, an address, a style, an event handler) reaches the
 *    picture the screenshot Worker draws;
 *  - the picture is Tex's: one ink, the calm Tex from the app's geometry;
 *  - only a page with no picture of its own is sent back for one, a bounded
 *    number of times, and the drawing is saved into the page through
 *    `write_note`, with the etag read, as two pictures its front matter names;
 *  - the page then shows it as its cover, light and dark, and its texted
 *    picture and link card is the wide 1200 x 630 title and drawing.
 *
 * Decision: `docs/decisions/app-and-console/page-drawings.md`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `readScene` keeping unknown attributes and `shapeSvg` writing them
 *     (`drawing.cjs`: the `COMMON`/`SHAPES` filter, `readAttr`'s default and
 *     `shapeSvg`'s own list, all three, since each alone holds) → "nothing
 *     the model writes rides into the picture" fails.
 *   `ensurePageDrawing` skipping `hasPicture` (`pageDrawing.js`) → "a page
 *     with a picture of its own is never sent back for a drawing" fails.
 *   `ensurePageDrawing` never giving up (`MAX_DRAWING_TRIES` ignored) → "a
 *     turn that cannot draw one still ends with the cover" fails.
 *   `drawingCard` dropped from `pageCover` (`visuals/page.js`) → "a drawn
 *     page is texted as the wide card of its title and drawing" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readScene, drawingSvg, drawingHtml } from "../../../packages/shared/src/ink/drawing.cjs";
import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { hasPicture } from "../../../packages/shared/src/pages/cover.cjs";
import { PAGE_SKILL_STAMP } from "../src/pageSkill.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { VISUAL_TOOL } from "../src/agent/visuals/index.js";
import { DRAWING_DARK_NAME, DRAWING_NAME, MAX_DRAWING_TRIES, SCENE_ASK, withDrawingFields } from "../src/agent/visuals/pageDrawing.js";

const SCENE = [
  '<svg viewBox="0 0 1200 900">',
  '<rect x="200" y="300" width="500" height="320" rx="20" fill="paper"/>',
  '<path d="M200 300 L450 160 L700 300 Z" fill="hatch"/>',
  '<g transform="translate(800 400) rotate(-8)"><circle cx="0" cy="0" r="90"/><line x1="-60" y1="0" x2="60" y2="0"/></g>',
  '<text x="450" y="500" font-size="60" text-anchor="middle">12 weeks</text>',
  '<tex x="1000" y="820" size="200" flip="true"/>',
  "</svg>",
].join("");

const PAGE = [
  "---",
  `skill: ${PAGE_SKILL_STAMP}`,
  "title: A 100-person concert",
  "kind: plan",
  "---",
  "",
  "Twelve weeks to show day; the venue comes first.",
  "",
  "## Next",
  "",
  "- [ ] Hold two venues",
  "",
].join("\n");

test("a scene is read into shapes and drawn again in Tex's ink, with the calm Tex", () => {
  const scene = readScene(SCENE);
  assert.equal(scene.error, null);
  assert.equal(scene.tex.size, 200);
  const light = drawingSvg(scene, { seed: "x" });
  const dark = drawingSvg(scene, { dark: true, seed: "x" });
  assert.match(light, /data-tex="calm"/);
  assert.match(light, /stroke="#2A45CF"/);
  assert.match(dark, /stroke="#8A9BF2"/);
  assert.match(light, /fill="url\(#ink-hatch\)"/);
  assert.match(light, />12 weeks<\/text>/);
  // The same scene is the same picture.
  assert.equal(drawingSvg(scene, { seed: "x" }), light);
  // A scene that names no Tex still has one, at its foot.
  const bare = readScene('<circle cx="600" cy="450" r="200"/>');
  assert.match(drawingSvg(bare), /data-tex="calm"/);
});

test("nothing the model writes rides into the picture", () => {
  for (const [markup, why] of [
    ['<script>alert(1)</script>', /not drawn/],
    ['<image href="https://evil.example/x.png"/>', /not drawn/],
    ['<foreignObject><div>x</div></foreignObject>', /not drawn/],
    ['<a href="https://evil.example"><circle r="4"/></a>', /not drawn/],
    ['<path d="M0 0 url(https://evil.example)"/>', /path commands/],
    ['<rect x="javascript:1" width="10" height="10"/>', /a number/],
    ['<g transform="matrix(1 0 0 1 0 0)"><circle r="4"/></g>', /translate, rotate or scale/],
    ["just words", /inside <text>/],
  ]) {
    const read = readScene(markup);
    assert.equal(read.shapes, null, markup);
    assert.match(read.error, why, markup);
  }
  const html = drawingHtml(
    readScene('<circle cx="10" cy="10" r="5" onload="alert(1)" style="fill:url(https://evil.example)" fill="url(https://evil.example/x)" filter="url(#x)" href="https://evil.example"/><text x="1" y="2">&lt;b&gt;hi</text>'),
  );
  assert.doesNotMatch(html, /onload|style="|evil\.example|<b>/);
  // The only addresses in it are the SVG namespace and the page's face.
  const addresses = [...html.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
  assert.ok(addresses.every((a) => a === "http://www.w3.org/2000/svg" || a.startsWith("https://fonts.googleapis.com/")), addresses.join(" "));
});

test("the page shows its drawing as its cover, light and dark, and a photo always wins", () => {
  const drawn = parsePage(withDrawingFields(PAGE, "upload-1111111111111111.png", "upload-2222222222222222.png"));
  const { html } = renderPage(drawn, { cover: true });
  assert.match(html, /pg-cover-drawn/);
  assert.match(html, /class="pg-ink-light" data-src="upload-1111111111111111\.png"/);
  assert.match(html, /class="pg-ink-dark" data-src="upload-2222222222222222\.png"/);
  // A drawing is not a picture of its own, so a page can be drawn again.
  assert.equal(hasPicture(drawn), false);
  const photographed = parsePage(withDrawingFields(PAGE.replace("kind: plan", "kind: plan\ncover: upload-4444444444444444.jpg"), "upload-1111111111111111.png", "upload-2222222222222222.png"));
  assert.equal(hasPicture(photographed), true);
  assert.doesNotMatch(renderPage(photographed, { cover: true }).html, /pg-cover-drawn/);
});

test("the drawing's fields go in the front matter, in place of any already there", () => {
  const once = withDrawingFields(PAGE, "a.png", "b.png");
  assert.match(once, /^---\nskill: .*\ntitle: A 100-person concert\nkind: plan\ndrawing: a\.png\ndrawing-dark: b\.png\n---\n\nTwelve weeks/);
  const twice = withDrawingFields(once, "c.png", "d.png");
  assert.equal((twice.match(/^drawing:/gm) ?? []).length, 1);
  assert.match(twice, /drawing: c\.png\ndrawing-dark: d\.png\n---/);
  assert.equal(withDrawingFields("# Plain\n", "a.png", "b.png"), "---\ndrawing: a.png\ndrawing-dark: b.png\n---\n\n# Plain\n");
});

/** A workspace of one page, as the turn's tools see it: read_note, read_image and write_note. */
function workspace(initial) {
  const state = { text: initial, etag: '"e1"', writes: [], images: new Map() };
  const callTool = async (name, args) => {
    if (name === "read_note") return { content: [{ type: "text", text: `etag: ${state.etag}\npath: ${args.path}\nvisibility: private\n\n${state.text}` }] };
    if (name === "read_image") {
      const data = state.images.get(args.image);
      return data ? { content: [{ type: "text", text: "image" }, { type: "image", data, mimeType: "image/png" }] } : { isError: true, content: [{ type: "text", text: "not found" }] };
    }
    if (name === "write_note") {
      state.writes.push(args);
      if (args.expected_etag !== state.etag) return { isError: true, content: [{ type: "text", text: "etag mismatch" }] };
      // As write_note does: each attached picture is stored and its name in a field becomes the stored leaf.
      let text = args.content;
      for (const [i, image] of (args.images ?? []).entries()) {
        const leaf = `upload-${String(i + 1).repeat(16)}.png`;
        state.images.set(leaf, image.data.replace(/^data:image\/png;base64,/, ""));
        text = text.replace(image.name, leaf);
      }
      state.text = text;
      state.etag = '"e2"';
      return { content: [{ type: "text", text: "saved" }] };
    }
    return { isError: true, content: [{ type: "text", text: `no ${name}` }] };
  };
  return { state, callTool };
}

function siteShots() {
  const calls = [];
  return {
    calls,
    SITE_SHOTS: {
      async fetch(_url, init) {
        const body = JSON.parse(init.body);
        calls.push(body);
        return new Response(JSON.stringify({ png: `iVBORw0KGgo${calls.length}`, width: body.width, height: body.height, blocked: [] }), { status: 200 });
      },
    },
  };
}

test("a page with no picture is sent back to draw one, and the drawing is saved into it", async () => {
  const shots = siteShots();
  const kept = [];
  const maker = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }), keepCover: async (path, png) => (kept.push([path, png]), true) });
  const { state, callTool } = workspace(PAGE);
  const draw = withPictureMaker(maker, callTool);

  const asked = await draw(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md" } });
  assert.equal(asked.isError, true);
  assert.equal(asked.content[0].text, SCENE_ASK);
  assert.equal(shots.calls.length, 0, "nothing is drawn before the scene");

  const drawn = await draw(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md", scene: SCENE } });
  // Two drawings, light and dark, at the drawing's size, loading nothing.
  const [light, dark, card] = shots.calls;
  assert.deepEqual([light.width, light.height, dark.width, dark.height], [1200, 1000, 1200, 1000]);
  assert.deepEqual([light.allow, dark.allow], [[], []]);
  assert.match(light.html, /#2A45CF/);
  assert.match(dark.html, /#8A9BF2/);
  // Saved with the etag it read, as two pictures the front matter names.
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].expected_etag, '"e1"');
  assert.deepEqual(state.writes[0].images.map((image) => image.name), [DRAWING_NAME, DRAWING_DARK_NAME]);
  assert.match(state.text, /^drawing: upload-1{16}\.png$/m);
  assert.match(state.text, /^drawing-dark: upload-2{16}\.png$/m);
  assert.match(state.text, /Twelve weeks to show day/, "the page's words are kept");
  // Then texted, and kept for the link, as the wide card of its title and drawing.
  assert.deepEqual([card.width, card.height], [1200, 630]);
  assert.match(card.html, /A 100-person concert/);
  assert.match(card.html, /url\("data:image\/png;base64,iVBORw0KGgo1"\)/);
  assert.equal(drawn.content[0].type, "image");
  assert.match(drawn.content[1].text, /drawing is saved in the page/);
  assert.deepEqual(kept, [["projects/concert.page.md", "iVBORw0KGgo3"]]);

  // Drawn once, it is not asked for again; a dark turn's card uses the dark drawing.
  const again = await draw(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md" }, theme: "dark" });
  assert.equal(again.content[0].type, "image");
  assert.match(shots.calls.at(-1).html, /url\("data:image\/png;base64,iVBORw0KGgo2"\)/);
});

test("a page with a picture of its own is never sent back for a drawing", async () => {
  for (const page of [PAGE.replace("kind: plan", "kind: plan\ncover: upload-4444444444444444.jpg"), PAGE.replace("## Next", "![[upload-5555555555555555.png]]\n\n## Next"), PAGE.replace("kind: plan", "kind: status\nnumber: 12 of 40")]) {
    const shots = siteShots();
    const { state, callTool } = workspace(page);
    const drawn = await withPictureMaker(pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) }), callTool)(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md" } });
    assert.equal(drawn.content[0].type, "image", page);
    assert.equal(state.writes.length, 0);
    assert.deepEqual([shots.calls[0].width, shots.calls[0].height], [1080, 1350]);
  }
});

test("a status page with no number is drawn like any other page, and its cover is the drawing, not an empty band", async () => {
  // Tex's seven-day status page (2026-11-03) had `kind: status` and no `number:`: no drawing was asked for, and its
  // cover was the number band with no number in it, so the page and its link picture came out bare.
  const page = PAGE.replace("kind: plan", "kind: status");
  const shots = siteShots();
  const { callTool } = workspace(page);
  const asked = await withPictureMaker(pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) }), callTool)(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md" } });
  assert.equal(asked.content[0].text, SCENE_ASK);
  const drawn = renderPage(parsePage(withDrawingFields(page, "upload-1111111111111111.png", "upload-2222222222222222.png")), { cover: true }).html;
  assert.doesNotMatch(drawn, /pg-cover-num/);
  assert.match(drawn, /pg-cover-drawn/);
  assert.match(renderPage(parsePage(PAGE.replace("kind: plan", "kind: status\nnumber: 12 of 40")), { cover: true }).html, /pg-cover-num/, "a numbered status page keeps its number");
});

test("a turn that cannot draw one still ends with the cover", async () => {
  const shots = siteShots();
  const { state, callTool } = workspace(PAGE);
  const draw = withPictureMaker(pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) }), callTool);
  const args = { template: "page", data: { path: "projects/concert.page.md", scene: "<blink>hi</blink>" } };
  for (let i = 0; i < MAX_DRAWING_TRIES; i++) {
    const refused = await draw(VISUAL_TOOL, args);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /could not be drawn: <blink> is not drawn/);
  }
  const drawn = await draw(VISUAL_TOOL, args);
  assert.equal(drawn.content[0].type, "image");
  assert.match(drawn.content[1].text, /its drawing could not be made this turn/);
  assert.equal(state.writes.length, 0);
  // A write that is refused (a read-only turn, someone else's edit) is sent back the same bounded way.
  const busy = workspace(PAGE);
  busy.state.etag = '"e1"';
  const writes = [];
  const refusing = async (name, a) => (name === "write_note" ? (writes.push(a), { isError: true, content: [{ type: "text", text: "You cannot edit this note." }] }) : busy.callTool(name, a));
  const drawRefused = withPictureMaker(pictureMaker(siteShots(), { outgoing: outgoingPictures({ enabled: true }) }), refusing);
  const first = await drawRefused(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md", scene: SCENE } });
  assert.match(first.content[0].text, /could not be saved into the page: You cannot edit this note/);
  await drawRefused(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md", scene: SCENE } });
  const last = await drawRefused(VISUAL_TOOL, { template: "page", data: { path: "projects/concert.page.md", scene: SCENE } });
  assert.equal(last.content[0].type, "image");
  assert.equal(writes.length, MAX_DRAWING_TRIES);
});
