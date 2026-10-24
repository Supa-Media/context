/**
 * A group chat's review (2026-10-24): Tex texted "the browser still won't open
 * claude.ai/login from this chat" and "the browser refused the address" in
 * turns where no browser step ran, four times, then signed in at the first
 * real try. These prove an answer that calls a page blocked is sent back to
 * try the browser first, whether the last try failed or there was none.
 *
 * Sabotage record (2026-10-24): dropping the `!browserTried` condition failed
 * "a browser that was tried and worked"; dropping `canBrowse()` failed "a turn
 * with no browser"; reverting the `refus`/`blocked` alternatives in
 * `BROWSER_GAVE_UP` failed "the texts from the group chat".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_RETRY_NOTICE, BROWSER_UNTRIED_NOTICE, claimCheck, givesUpOnTheBrowser } from "../src/agent/claimCheck.js";

const BROWSE = { name: "browse" };
const web = (tools, results = {}) => ({
  tools,
  usage: {},
  call: async (name) => results[name] ?? { content: [{ type: "text", text: "ok" }] },
});

const SAID = [
  "I tried again, and the browser still won't open claude.ai/login from this chat. I can't type the email until it does.",
  "I tried to open claude.ai/login to take the picture, and the browser refused the address from this chat.",
  "A search found claude.ai/login, but my browser still can't open it from this chat, so I can't request a code.",
  "The sign-in page is still blocked for me, so nothing is signed in.",
];

test("the texts from the group chat give up on the browser", () => {
  for (const said of SAID) assert.ok(givesUpOnTheBrowser(said), said);
  assert.ok(!givesUpOnTheBrowser("I'm signed in to Claude as dev2@supa.media."));
});

test("a page called blocked with no browser step this turn is sent back to try it", async () => {
  for (const said of SAID) {
    const claims = claimCheck({ question: "i'll give you the code once you try logging in" });
    const wrapped = claims.wrapWeb(web([BROWSE, { name: "search_web" }]));
    await wrapped.call("search_web", {});
    assert.equal(claims.check(said), BROWSER_UNTRIED_NOTICE, said);
    assert.notEqual(claims.check(said), BROWSER_UNTRIED_NOTICE, "once a turn");
  }
  assert.match(BROWSER_UNTRIED_NOTICE, /no browser step ran/);
});

test("a browser that was tried and worked is not sent round again", async () => {
  const claims = claimCheck({ question: "open claude.ai/login" });
  const wrapped = claims.wrapWeb(web([BROWSE]));
  await wrapped.call("browse", {});
  const said = "The page loaded, but the site still can't open the billing tab for this plan.";
  const notice = claims.check(said);
  assert.notEqual(notice, BROWSER_UNTRIED_NOTICE);
  assert.notEqual(notice, BROWSER_RETRY_NOTICE);
});

test("a turn with no browser is not told to use one", () => {
  const claims = claimCheck({ question: "open claude.ai/login" });
  claims.wrapWeb(web([{ name: "open_page" }]));
  assert.notEqual(claims.check(SAID[0]), BROWSER_UNTRIED_NOTICE);
});

test("something else it couldn't get is not about the browser", () => {
  const claims = claimCheck({ question: "what's the code?" });
  claims.wrapWeb(web([BROWSE]));
  assert.notEqual(claims.check("I couldn't get the code: it went to dev2's inbox, which I can't search from here."), BROWSER_UNTRIED_NOTICE);
});

test("a failed address is told to search for the page", () => {
  assert.match(BROWSER_RETRY_NOTICE, /search for the page with search_web/);
});
