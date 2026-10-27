/**
 * The owner's 1:1 of 2026-10-27: asked to fill in a Bible study note's verse
 * analysis, Tex texted "I couldn't open the LSB text for chapter 32 from here,
 * so I haven't quoted any verses. Paste them in and I'll quote them from your
 * text." No check sent it back: a page read had been tried, so `TRY_NOTICE`
 * stayed quiet, and nothing knew "paste" as a hand-back (`publishedText.js`).
 *
 * Sabotage record (2026-10-27): dropping the `aPageReadFailed` branch from
 * `claimCheck.js` failed "a failed page read with the browser untried"; dropping
 * the paste branch failed "the owner's text is sent back"; dropping the first
 * `ASKS_FOR_IT` pattern failed "asks for published text"; removing the
 * `thinPageHint` line from `pageText` failed "an empty page read says to browse".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { claimCheck } from "../src/agent/claimCheck.js";
import { webPrompt, webSession } from "../src/agent/computer.js";
import { READ_FAILED_NOTICE, asksForPublishedText, publishedTextNotice, thinPageHint } from "../src/agent/publishedText.js";

const OWNER =
  "The Verse Analysis is still blank. I couldn’t open the LSB text for chapter 32 from here, so I haven't quoted any verses. Paste them in and I'll quote them from your text.";

const web = (tools, results = {}) => ({
  tools: tools.map((name) => ({ name })),
  usage: {},
  call: async (name) => results[name] ?? { content: [{ type: "text", text: "ok" }] },
});
const FAILED = { content: [{ type: "text", text: "That page could not be opened." }], isError: true };

test("asks for published text", () => {
  for (const said of [
    OWNER,
    "Paste it here and I'll fill in the analysis.",
    "If you paste the verses I'll quote them.",
    "Send me the passage and I'll add it.",
    "Can you copy and paste the lyrics?",
    "Text me chapter 32 and I'll quote it.",
  ]) {
    assert.ok(asksForPublishedText(said), said);
  }
  for (const said of [
    "Done: added verses 1 to 6 to your Verse Analysis.",
    "I'll send the passage to Ama once you say yes.",
    "Pasted the verses into your note.",
    "Paste this link into ChatGPT's connector settings.",
    "Want me to text you the reading plan each morning?",
  ]) {
    assert.ok(!asksForPublishedText(said), said);
  }
});

test("the owner's text is sent back after a failed read, to the browser first", async () => {
  const claims = claimCheck({ question: "fill in the verse analysis from the LSB" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"], { open_page: FAILED }));
  await wrapped.call("search_web", {});
  await wrapped.call("open_page", {});
  assert.equal(claims.check(OWNER), READ_FAILED_NOTICE);
  // The browser was then tried and the answer still asks them to paste: the paste notice.
  await wrapped.call("browse", {});
  assert.equal(claims.check(OWNER), publishedTextNotice({ canBrowse: true }));
  // Once each.
  const third = await claims.check(OWNER);
  assert.notEqual(third, READ_FAILED_NOTICE);
  assert.notEqual(third, publishedTextNotice({ canBrowse: true }));
});

test("the owner's text is sent back when every read worked but showed nothing", async () => {
  const claims = claimCheck({ question: "fill in the verse analysis from the LSB" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"]));
  await wrapped.call("open_page", {});
  assert.equal(claims.check(OWNER), publishedTextNotice({ canBrowse: true }));
});

test("a failed page read with the browser untried is sent to the browser", async () => {
  const claims = claimCheck({ question: "what does deuteronomy 32:4 say in the LSB" });
  const wrapped = claims.wrapWeb(web(["open_page", "browse"], { open_page: FAILED }));
  await wrapped.call("open_page", {});
  assert.equal(claims.check("I couldn't open the LSB text for chapter 32."), READ_FAILED_NOTICE);
});

test("no browser on offer: the paste notice says nothing about browse", async () => {
  const claims = claimCheck({ question: "quote psalm 23 in the LSB" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page"], { open_page: FAILED }));
  await wrapped.call("open_page", {});
  const notice = claims.check(OWNER);
  assert.equal(notice, publishedTextNotice({ canBrowse: false }));
  assert.doesNotMatch(notice, /browse/);
});

test("a turn with no web is not told to find text on it", () => {
  const claims = claimCheck({ question: "quote psalm 23" });
  assert.notEqual(claims.check(OWNER), publishedTextNotice({ canBrowse: false }));
});

test("an empty page read says to browse", async () => {
  assert.match(thinPageHint(""), /browse/);
  assert.equal(thinPageHint("x".repeat(400)), "");
  const session = webSession({ async readPage(url) { return { url, title: "LSB", text: "", links: [] }; } }, "https://read.example/lsb/deut/32");
  const result = await session.call("open_page", { url: "https://read.example/lsb/deut/32" });
  assert.match(result.content[0].text, /Almost no text came back/);
  const full = webSession({ async readPage(url) { return { url, title: "LSB", text: "Give ear, O heavens. ".repeat(20), links: [] }; } }, "https://read.example/lsb/deut/32");
  assert.doesNotMatch((await full.call("open_page", { url: "https://read.example/lsb/deut/32" })).content[0].text, /Almost no text/);
});

test("the prompt says published text is Tex's to find", () => {
  assert.match(webPrompt(new Set(["open_page", "browse"])), /Never ask them to paste or send it/);
  assert.match(webPrompt(new Set(["open_page", "browse"])), /open it with browse/);
  assert.doesNotMatch(webPrompt(new Set(["open_page"])), /open it with browse/);
});
