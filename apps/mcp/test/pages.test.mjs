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
 *   `keepCover` not called after the draw → "a drawn cover is kept for the
 *     page's link card" fails.
 *   `pageSkillMissing` dropped from `toolWriteNote` → "a page is written only
 *     by a caller who read the page design skill" fails.
 *   `pageCover` keeping any `data:` value → "a cover's photos are read through
 *     the page's own note" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_GUIDE, pageProblems, pageSkillMissing } from "../src/pages.js";
import { PAGE_SKILL, PAGE_SKILL_STAMP } from "../src/pageSkill.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { jobPrompt } from "../src/agent/background.js";
import { outgoingPictures } from "../src/agent/outgoingPictures.js";
import { pictureMaker, withPictureMaker } from "../src/agent/pictureMaker.js";
import { createTreeMethods, MAX_COVER_CHARS } from "../src/controlPlane/tree.js";
import { VISUAL_DEFINITION, VISUAL_TOOL } from "../src/agent/visuals/index.js";
import { pageCover } from "../src/agent/visuals/page.js";
import { BLOCK_KINDS } from "../../../packages/shared/src/pages/blocks.cjs";

const GOOD = [
  "---",
  `skill: ${PAGE_SKILL_STAMP}`,
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

const BROKEN = ["---", `skill: ${PAGE_SKILL_STAMP}`, "---", "# Sales", "", "```chart By month", "- Jan", "```", "", "```choose", "- Only one", "```", ""].join("\n");

test("a page whose blocks can be drawn passes; one that cannot names each line to fix", () => {
  assert.equal(pageProblems(GOOD), null);
  const refusal = pageProblems(BROKEN);
  assert.match(refusal, /not saved/);
  assert.match(refusal, /line 6: chart "By month": "Jan" needs a label first/);
  assert.match(refusal, /line 6: chart "By month": A chart needs at least two numbers/);
  assert.match(refusal, /line 10: choose: A choice needs at least two options/);
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

test("a page is written only by a caller who read the page design skill as it is now", async () => {
  // The skill is what orient about: "pages" answers, and it ends with the stamp a page must carry.
  assert.equal(PAGE_GUIDE, PAGE_SKILL);
  assert.match(PAGE_SKILL, /^# Page design skill/);
  assert.ok(PAGE_SKILL.trimEnd().endsWith(`skill: ${PAGE_SKILL_STAMP}\``));
  assert.match(PAGE_SKILL_STAMP, /^pages-[0-9a-f]{8}$/);
  assert.equal(pageSkillMissing(GOOD), null);
  const unread = GOOD.replace(`skill: ${PAGE_SKILL_STAMP}\n`, "");
  assert.match(pageSkillMissing(unread), /read the page design skill first/);
  assert.match(pageSkillMissing(unread), /orient about: "pages"/);
  assert.match(pageSkillMissing(GOOD.replace(PAGE_SKILL_STAMP, "pages-00000000")), /older page design skill/);
  // The refusal is the read: it carries the whole skill and its stamp, and says to write the page again, never a plain
  // note (2026-10-27: refused in a WhatsApp group, Tex saved a plain note and said pages "wouldn't save from this chat").
  assert.ok(pageSkillMissing(unread).includes(PAGE_SKILL));
  assert.ok(pageSkillMissing(unread).includes(`skill: ${PAGE_SKILL_STAMP} in its front matter`));
  assert.match(pageSkillMissing(unread), /Never save it as a plain note instead/);
  // Refused before anything is looked up, and only for pages.
  const store = new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => assert.fail(`store.${String(key)} was used`)) });
  const refused = await toolWriteNote(store, { kind: "private" }, {}, {}, { path: "projects/dinner.page.md", content: unread });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /page design skill/);
  assert.ok(refused.content[0].text.includes(PAGE_SKILL_STAMP), "the refused writer is handed the stamp with the skill");
  const plain = await toolWriteNote({}, { kind: "private" }, {}, {}, { path: "projects/dinner.md", content: unread }).catch((error) => ({ thrown: error }));
  assert.doesNotMatch(JSON.stringify(plain), /page design skill/);
});

test("the format guide lists every block kind the checks know", () => {
  for (const kind of Object.keys(BLOCK_KINDS)) assert.match(PAGE_GUIDE, new RegExp(`\`${kind}\`: `), kind);
  assert.match(PAGE_GUIDE, /```` ```box height=320 ````/);
});

test("a background job delivers a page and texts its cover with the link", () => {
  const prompt = jobPrompt({ title: "Caterers", brief: "find three", doneWhen: "", attempt: 1, followUps: [], draft: "", unfinished: false });
  assert.match(prompt, /<name>\.page\.md/);
  assert.match(prompt, /Read the page design skill first \(orient about: "pages"\)/);
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

test("a cover's photos are read through the page's own note and drawn in as bytes", async () => {
  const shots = siteShots();
  const maker = pictureMaker(shots, { outgoing: outgoingPictures({ enabled: true }) });
  const pictured = GOOD.replace("title: Dinner for 40", "title: Dinner for 40\nkind: plan\ncover: upload-1111111111111111.png, upload-2222222222222222.png");
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === "read_note") return { content: [{ type: "text", text: `etag: "e1"\npath: ${args.path}\nvisibility: private\n\n${pictured}` }] };
    // The first is there; the second the turn may not see.
    if (args.image === "upload-1111111111111111.png") return { content: [{ type: "text", text: "image" }, { type: "image", data: "QUJD", mimeType: "image/png" }] };
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  await withPictureMaker(maker, callTool)(VISUAL_TOOL, { template: "page", data: { path: "projects/dinner.page.md" } });
  assert.deepEqual(calls.slice(1), [
    ["read_image", { note: "projects/dinner.page.md", image: "upload-1111111111111111.png" }],
    ["read_image", { note: "projects/dinner.page.md", image: "upload-2222222222222222.png" }],
  ]);
  const { html } = shots.calls[0];
  assert.match(html, /<img src="data:image\/png;base64,QUJD"/);
  // Nothing on a cover loads by itself: the one it could not read is a slot with the page's initial.
  assert.doesNotMatch(html, /data-src=/);
  // Bytes that are not a picture are never drawn in.
  const { html: odd } = pageCover("x.page.md", pictured, "light", new Map([["upload-1111111111111111.png", "data:text/html;base64,PHNjcmlwdD4="]]));
  assert.doesNotMatch(odd, /data:text\/html/);
});

test("a drawn cover is kept for the page's link card, and a failed keep costs nothing", async () => {
  const kept = [];
  const read = async (_name, args) => ({ content: [{ type: "text", text: `etag: "e1"\npath: ${args.path}\nvisibility: private\n\n${GOOD}` }] });
  const keeping = pictureMaker(siteShots(), { outgoing: outgoingPictures({ enabled: true }), keepCover: async (path, png) => (kept.push([path, png]), true) });
  await withPictureMaker(keeping, read)(VISUAL_TOOL, { template: "page", data: { path: "projects/dinner.page.md" } });
  // Another context's page is not this turn's to keep.
  await withPictureMaker(keeping, read)(VISUAL_TOOL, { template: "page", data: { path: "@band/projects/dinner.page.md" } });
  assert.deepEqual(kept, [["projects/dinner.page.md", "iVBORw0KGgo="]]);
  const failing = pictureMaker(siteShots(), { outgoing: outgoingPictures({ enabled: true }), keepCover: async () => { throw new Error("down"); } });
  const drawn = await withPictureMaker(failing, read)(VISUAL_TOOL, { template: "page", data: { path: "projects/dinner.page.md" } });
  assert.equal(drawn.content[0].type, "image");
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

test("a cover goes to the control plane with the person's own token, and a huge one does not go", async () => {
  const posts = [];
  const tree = createTreeMethods({ post: async (path, body) => (posts.push([path, body]), { recorded: true }) });
  assert.equal(await tree.recordPageCover("tok", "ws1", "projects/dinner.page.md", "iVBORw0KGgo="), true);
  assert.deepEqual(posts, [["/gateway/page-cover", { path: "projects/dinner.page.md", png: "iVBORw0KGgo=", accessToken: "tok", expectedWorkspaceId: "ws1" }]]);
  assert.equal(await tree.recordPageCover("tok", "ws1", "projects/dinner.page.md", "A".repeat(MAX_COVER_CHARS + 1)), false);
  assert.equal(posts.length, 1);
});
