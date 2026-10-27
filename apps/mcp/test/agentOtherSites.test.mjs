/**
 * The owner's 1:1 of 2026-10-27: asked to fill in a Bible study note's verse
 * analysis, Tex texted "I couldn't open the LSB text for chapter 32 from here,
 * so I haven't quoted any verses. Paste them in and I'll quote them from your
 * text." The owner: Tex should look at alternative sites when one doesn't
 * work, for any website, article or platform, with no list of sites
 * (`otherSites.js`).
 *
 * Sabotage record (2026-10-27): dropping the other-sites branch from
 * `claimCheck.js` failed "a give-up after one failed site"; ignoring the site
 * count failed "enough sites tried"; counting a failed browser step failed "a
 * failed browser step is the retry notice's"; dropping the paste branch failed "the owner's
 * text is sent back when every read worked"; dropping the first
 * `ASKS_FOR_IT` pattern failed "asks for published text"; restoring the bare
 * "That page could not be opened." failed "a failed read says what to do next";
 * removing the `thinPageHint` line failed "an empty page read says to browse".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { claimCheck } from "../src/agent/claimCheck.js";
import { webPrompt, webSession } from "../src/agent/computer.js";
import { READ_FAILED_NEXT, asksForPublishedText, hostsAsked, otherSitesNotice, publishedTextNotice, thinPageHint } from "../src/agent/otherSites.js";

const OWNER =
  "The Verse Analysis is still blank. I couldn’t open the LSB text for chapter 32 from here, so I haven't quoted any verses. Paste them in and I'll quote them from your text.";

const web = (tools, results = {}) => ({
  tools: tools.map((name) => ({ name })),
  usage: {},
  call: async (name, args) => (typeof results[name] === "function" ? results[name](args) : results[name]) ?? { content: [{ type: "text", text: "ok" }] },
});
const FAILED = { content: [{ type: "text", text: "That page could not be opened." }], isError: true };
const open = (url) => ["open_page", { url }];

test("asks for published text", () => {
  for (const said of [
    OWNER,
    "Paste it here and I'll fill in the analysis.",
    "If you paste the verses I'll quote them.",
    "Send me the article and I'll summarise it.",
    "Can you copy and paste the lyrics?",
    "Text me the recipe and I'll add it.",
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

test("the sites a call asked for", () => {
  assert.deepEqual(hostsAsked("open_page", { url: "https://www.example.org/a" }), ["example.org"]);
  assert.deepEqual(hostsAsked("open_page", { urls: ["https://a.example/x", "https://b.example/y"] }), ["a.example", "b.example"]);
  assert.deepEqual(hostsAsked("browse", { steps: [{ do: "goto", url: "https://c.example/" }, { do: "click", ref: 3 }] }), ["c.example"]);
  assert.deepEqual(hostsAsked("search_web", { query: "x" }), []);
  assert.deepEqual(hostsAsked("open_page", { url: "not an address" }), []);
});

test("a give-up after one failed site is sent to other sites, for any kind of page", async () => {
  for (const said of [
    OWNER,
    "I couldn't open the recipe page, so I don't have the quantities.",
    "I can't tell you the price: the store's page wouldn't load.",
  ]) {
    const claims = claimCheck({ question: "get me the text" });
    const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"], { open_page: FAILED }));
    await wrapped.call("search_web", { query: "x" });
    await wrapped.call(...open("https://reader.example/a"));
    assert.equal(claims.check(said), otherSitesNotice({ sites: 1, canBrowse: true }), said);
  }
  assert.match(otherSitesNotice({ sites: 1, canBrowse: true }), /another|different sites/);
  assert.doesNotMatch(otherSitesNotice({ sites: 1, canBrowse: false }), /browse/);
});

test("after the other-sites round, a paste ask still goes back once, then the answer goes", async () => {
  const claims = claimCheck({ question: "fill in the verse analysis" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"], { open_page: FAILED }));
  await wrapped.call(...open("https://reader.example/a"));
  assert.equal(claims.check(OWNER), otherSitesNotice({ sites: 1, canBrowse: true }));
  assert.equal(claims.check(OWNER), publishedTextNotice({ canBrowse: true }));
  const third = await claims.check(OWNER);
  assert.notEqual(third, otherSitesNotice({ sites: 1, canBrowse: true }));
  assert.notEqual(third, publishedTextNotice({ canBrowse: true }));
});

test("enough sites tried: an honest give-up is not sent round again", async () => {
  const claims = claimCheck({ question: "quote it" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"], { open_page: FAILED }));
  for (const url of ["https://a.example/x", "https://b.example/x", "https://c.example/x"]) await wrapped.call(...open(url));
  const said = "I couldn't open it on a.example, b.example or c.example: each refused the read.";
  assert.notEqual(claims.check(said), otherSitesNotice({ sites: 3, canBrowse: true }));
});

test("nothing failed: a plain answer is left alone", async () => {
  const claims = claimCheck({ question: "quote it" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page"]));
  await wrapped.call(...open("https://a.example/x"));
  assert.equal(claims.check("Verse 4: The Rock, whose work is whole."), null);
});

test("the owner's text is sent back when every read worked but showed nothing", async () => {
  const claims = claimCheck({ question: "fill in the verse analysis" });
  const wrapped = claims.wrapWeb(web(["search_web", "open_page", "browse"]));
  await wrapped.call(...open("https://reader.example/a"));
  assert.equal(claims.check(OWNER), publishedTextNotice({ canBrowse: true }));
});

test("a turn with no web is not told to find text on it", () => {
  const claims = claimCheck({ question: "quote psalm 23" });
  assert.notEqual(claims.check(OWNER), publishedTextNotice({ canBrowse: false }));
});

test("a failed read says what to do next", async () => {
  const session = webSession({ async readPage() { return null; } }, "https://read.example/lsb/deut/32");
  const result = await session.call("open_page", { url: "https://read.example/lsb/deut/32" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes(READ_FAILED_NEXT));
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

test("the prompt says one site failing never ends the looking, and names no site", () => {
  const said = webPrompt(new Set(["open_page", "browse"]));
  assert.match(said, /find the same content on another site/);
  assert.match(said, /open it with browse/);
  assert.doesNotMatch(webPrompt(new Set(["open_page"])), /open it with browse/);
  for (const notice of [said, publishedTextNotice({ canBrowse: true }), otherSitesNotice({ sites: 1, canBrowse: true }), READ_FAILED_NEXT]) {
    assert.doesNotMatch(notice, /bible ?gateway|bible ?hub|blue letter|bible\.com/i);
  }
});

test("a failed browser step is the retry notice's, not a reason to try other sites", async () => {
  const claims = claimCheck({ question: "check out my cart" });
  const wrapped = claims.wrapWeb(web(["browse"], { browse: FAILED }));
  await wrapped.call("browse", { steps: [{ do: "goto", url: "https://shop.example/cart" }] });
  await wrapped.call("browse", { steps: [{ do: "click", ref: 4 }] });
  const notice = claims.check("I can't tell you whether the order went through yet.");
  assert.notEqual(notice, otherSitesNotice({ sites: 1, canBrowse: true }));
});
