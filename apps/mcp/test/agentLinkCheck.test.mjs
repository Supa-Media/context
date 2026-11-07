/**
 * A note link Tex texts is one a tool gave it (owner's report, 2026-11-03:
 * Tex saved `last-7-days-oct-27-to-nov-3.page.md` in a group chat's folder
 * and texted a link to `last-7-days.page.md`, which opened "That file does
 * not exist").
 *
 * ## Sabotage record
 *
 *   `unknown` returning [] always
 *     → "a shortened page name is sent back once" fails
 *   the `written:` path not counted as seen
 *     → "a written path backs its link even without a link line" fails
 *   history not read
 *     → "a link from an earlier text in the chat stands" fails
 *   the check not wired into `claimCheck`'s wrap
 *     → "claimCheck sends the shortened link back, once" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { noteLinkCheck, unknownLinkNotice } from "../src/agent/linkCheck.js";
import { claimCheck } from "../src/agent/claimCheck.js";

const ORIGIN = "https://context.lc";
const PAGE = "tex/groups/kite-willow-rocket/last-7-days-oct-27-to-nov-3.page.md";
const GIVEN = `${ORIGIN}/note/@supa/tex/groups/kite-willow-rocket/last-7-days-oct-27-to-nov-3.page.md`;
const SHORTENED = `${ORIGIN}/note/@supa/tex/groups/kite-willow-rocket/last-7-days.page.md`;
const written = (path, link) => ({ content: [{ type: "text", text: `written: ${path} (etag e1)\nvisibility: team${link ? `\nlink: ${link} (text this on its own line so they can open the note)` : ""}` }] });

test("a shortened page name is sent back once, and the link it was given is named", () => {
  const links = noteLinkCheck({ origin: ORIGIN });
  links.read(written(PAGE, GIVEN));
  const unknown = links.unknown(`It's saved as a page.\n\nLink: ${SHORTENED} (tap the link)`);
  assert.deepEqual(unknown, [{ slug: "supa", path: "tex/groups/kite-willow-rocket/last-7-days.page.md" }]);
  const notice = unknownLinkNotice(unknown, links.known());
  assert.match(notice, /last-7-days\.page\.md/);
  assert.ok(notice.includes(GIVEN), "the link it was given is in the notice, to copy");
  assert.deepEqual(links.unknown(`Link: ${GIVEN}`), [], "the link as given passes");
});

test("a written path backs its link even without a link line", () => {
  const links = noteLinkCheck({ origin: ORIGIN });
  links.read(written(PAGE, null));
  assert.deepEqual(links.unknown(GIVEN), []);
});

test("a read's path, and a link inside a note it read, back a link", () => {
  const links = noteLinkCheck({ origin: ORIGIN });
  links.read({ content: [{ type: "text", text: `etag: e2\npath: projects/plan.page.md\n\nSee ${ORIGIN}/note/@supa/resources/brand/guide.md` }] });
  assert.deepEqual(links.unknown(`${ORIGIN}/note/@supa/projects/plan.page.md and ${ORIGIN}/note/@supa/resources/brand/guide.md`), []);
});

test("a link from an earlier text in the chat, or their own text, stands", () => {
  const links = noteLinkCheck({ origin: ORIGIN, question: `what about ${ORIGIN}/note/@supa/a.md?`, history: [{ role: "assistant", text: `Here: ${GIVEN}` }] });
  assert.deepEqual(links.unknown(`It's on the page from my last reply: ${GIVEN}, and ${ORIGIN}/note/@supa/a.md`), []);
});

test("the right path in the wrong workspace is sent back", () => {
  const links = noteLinkCheck({ origin: ORIGIN });
  const path = "projects/love-thy-neighbor/church-venues-150-seats.page.md";
  links.read(written(path, `${ORIGIN}/note/@public-worship/${path}`));
  assert.deepEqual(links.unknown(`${ORIGIN}/note/@seyi/${path}`), [{ slug: "seyi", path }]);
  assert.deepEqual(links.unknown(`${ORIGIN}/note/@public-worship/${path}`), []);
});

test("links elsewhere, and a deployment with no origin, are not checked", () => {
  assert.deepEqual(noteLinkCheck({ origin: ORIGIN }).unknown("https://example.com/note/@supa/x.md https://context.lc/pricing"), []);
  assert.deepEqual(noteLinkCheck({ origin: null }).unknown(SHORTENED), []);
});

test("claimCheck sends the shortened link back, once", async () => {
  const claims = claimCheck({ question: "write up the last 7 days as a page", origin: ORIGIN });
  const call = claims.wrap(async () => written(PAGE, GIVEN));
  await call("write_note", { path: PAGE, content: "# Last 7 days" });
  const answer = `It's saved as a page.\n\nLink: ${SHORTENED}`;
  const notice = await claims.check(answer);
  assert.match(String(notice), /no tool gave you that link/);
  assert.ok(!/no tool gave you that link/.test(String(await claims.check(answer))), "given once a turn");
  const fixed = claimCheck({ question: "write up the last 7 days as a page", origin: ORIGIN });
  await fixed.wrap(async () => written(PAGE, GIVEN))("write_note", { path: PAGE, content: "# Last 7 days" });
  assert.ok(!/no tool gave you that link/.test(String(await fixed.check(`It's saved as a page.\n\nLink: ${GIVEN}`))));
});
