/**
 * PAGES IN THE GATEWAY (Dev2, 2026-10-27: "lets do blocks and code at the same
 * time, i want extensibility, job results become pages"): a `.page.md` write
 * is checked like a form (`src/pages.js`), agents are given the format
 * (`orient about: "pages"`), a background job is told to deliver a page, and
 * `draw_visual { template: "page" }` texts its first screen
 * (`src/agent/visuals/page.js`). The format itself is proven where it lives,
 * `packages/shared/src/pages/`; these check what the gateway does with it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   the `isPagePath` check removed from `toolWriteNote` → "a page with a block
 *     that cannot be drawn is refused" fails.
 *   `withPictureMaker` not passing `callTool` on → "the cover is the page, read
 *     as the turn may read it" fails.
 *   `sealed` returning the CSS as written → "a page's CSS cannot end the cover's
 *     style element" fails.
 *   the job line dropped from `jobPrompt` → "a background job delivers a page"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_GUIDE, pageProblems } from "../src/pages.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { jobPrompt } from "../src/agent/background.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { VISUAL_DEFINITION, VISUAL_TOOL } from "../src/agent/visuals/index.js";
import { pageCover } from "../src/agent/visuals/page.js";
import { BLOCK_KINDS } from "../../../packages/shared/src/pages/blocks.cjs";

const GOOD = [
  "---",
  "title: Dinner for 40",
  "kicker: Caterers",
  "---",
  "",
  "Three caterers can do **Nov 8**; Casa Lola is cheapest.",
  "",
  "```compare Quotes per head",
  "limit: 35",
  "- Casa Lola: $29 | Family style",
  "- Ember & Oak: $33 | Plated",
  "```",
  "",
  "## Next",
  "",
  "- [ ] Book the caterer",
  "",
].join("\n");

const BROKEN = ["# Sales", "", "```chart By month", "- Jan", "```", "", "```choose", "- Only one", "```", ""].join("\n");

test("a page whose blocks can be drawn passes; one that cannot names each line to fix", () => {
  assert.equal(pageProblems(GOOD), null);
  const refusal = pageProblems(BROKEN);
  assert.match(refusal, /not saved/);
  assert.match(refusal, /line 3: chart "By month": "Jan" needs a label first/);
  assert.match(refusal, /line 3: chart "By month": A chart needs at least two numbers/);
  assert.match(refusal, /line 7: choose: A choice needs at least two options/);
  assert.match(refusal, /orient about: "pages"/);
});

test("a page with a block that cannot be drawn is refused, before anything is looked up", async () => {
  // The store answers nothing: the refusal comes before the first lookup, as a broken form's does.
  const store = new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => assert.fail(`store.${String(key)} was used`)) });
  const result = await toolWriteNote(store, { kind: "private" }, {}, {}, { path: "projects/sales.page.md", content: BROKEN });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /chart "By month"/);
  // The same words in an ordinary note are just Markdown: the check is for pages only.
  const plain = await toolWriteNote({}, { kind: "private" }, {}, {}, { path: "projects/sales.md", content: BROKEN }).catch((error) => ({ thrown: error }));
  assert.doesNotMatch(JSON.stringify(plain), /needs a label first/);
});

test("the format guide lists every block kind the checks know", () => {
  for (const kind of Object.keys(BLOCK_KINDS)) assert.match(PAGE_GUIDE, new RegExp(`\`${kind}\`: `), kind);
  assert.match(PAGE_GUIDE, /```` ```box height=320 ````/);
});

test("a background job delivers a page and texts its cover with the link", () => {
  const prompt = jobPrompt({ title: "Caterers", brief: "find three", doneWhen: "", attempt: 1, followUps: [], draft: "", unfinished: false });
  assert.match(prompt, /<name>\.page\.md/);
  assert.match(prompt, /draw_visual template page/);
  assert.match(prompt, /page's link/);
});

function siteShots() {
  const calls = [];
  return {
    calls,
    SITE_SHOTS: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push(body);
        return new Response(JSON.stringify({ png: "iVBORw0KGgo=", width: body.width, height: body.height, blocked: [] }), { status: 200 });
      },
    },
  };
}

test("the cover is the page, read as the turn may read it", async () => {
  assert.ok(VISUAL_DEFINITION.inputSchema.properties.template.enum.includes("page"));
  assert.match(VISUAL_DEFINITION.description, /- page: the first screen of a page/);
  const shots = siteShots();
  const maker = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) });
  const reads = [];
  const callTool = async (name, args) => {
    reads.push([name, args.path]);
    return { content: [{ type: "text", text: `etag: "e1"\npath: ${args.path}\nvisibility: private\n\n${GOOD}` }] };
  };
  const drawn = await withPictureMaker(maker, callTool)(VISUAL_TOOL, { template: "page", data: { path: "projects/dinner.page.md" } });
  assert.deepEqual(reads, [["read_note", "projects/dinner.page.md"]]);
  assert.equal(drawn.content[0].type, "image");
  assert.equal(shots.calls.length, 1);
  const { html, width, height } = shots.calls[0];
  assert.deepEqual([width, height], [1080, 1350]);
  assert.match(html, /Dinner for 40/);
  assert.match(html, /Casa Lola/);
  // Only the first screen: the sections after the first block are left for the page.
  assert.doesNotMatch(html, /Book the caterer/);
  // And it says nothing about addresses it never tried to load.
  assert.doesNotMatch(drawn.content[1].text, /did not load/);
});

test("a cover is only ever of a page that exists", async () => {
  const shots = siteShots();
  const maker = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) });
  const missing = async () => ({ isError: true, content: [{ type: "text", text: "not found" }] });
  const none = await withPictureMaker(maker, missing)(VISUAL_TOOL, { template: "page", data: { path: "projects/gone.page.md" } });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no page at projects\/gone\.page\.md/);
  const notPage = await withPictureMaker(maker, missing)(VISUAL_TOOL, { template: "page", data: { path: "projects/plain.md" } });
  assert.match(notPage.content[0].text, /draws a \.page\.md note/);
  assert.equal(shots.calls.length, 0);
});

test("a page's words are escaped on the cover, and its CSS cannot end the cover's style element", () => {
  const hostile = [
    "---",
    "title: <img src=x onerror=alert(1)>",
    "---",
    "",
    "Hello <script>alert(1)</script>",
    "",
    "```css",
    "h1{color:red}</style><script>alert(2)</script><style>",
    "```",
    "",
  ].join("\n");
  const { html } = pageCover("x.page.md", hostile, "light");
  assert.doesNotMatch(html, /<img src=x/);
  // One style element, opened and closed once: the page's CSS stayed inside it.
  assert.equal(html.match(/<\/style/gi).length, 1);
  assert.equal(html.match(/<style/gi).length, 1);
  assert.doesNotMatch(html.split("</style>")[1], /<script/);
});
