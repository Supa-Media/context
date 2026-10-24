/**
 * The owner's review of a texted Instacart order (2026-10-24): Tex said "the
 * cart won't open in my browser" four times and told the person to edit the
 * cart in the Instacart app, then a plain retry worked; and it handed a
 * "picture check" over without saying captcha. These prove the gateway now
 * notices each of those before the text goes, and that a browser call that
 * stumbles reads where it got to rather than saying it couldn't.
 *
 * Sabotage record (2026-10-24): removing `APP_HANDBACK` from `handsWorkBack`
 * failed "the texts that handed the cart back"; the retry notice's
 * `browserFailedLast` set true for any call failed "a browser call that
 * worked"; dropping the hiccup read in browse.js failed "a stumble reads".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_RETRY_NOTICE, CAPTCHA_NOTICE, HANDBACK_NOTICE, claimCheck, handsOverACaptcha, handsWorkBack } from "../src/agent/claimCheck.js";
import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";

test("the texts that handed the cart back are read as handing work back", () => {
  for (const said of [
    "Two ways to do it: in the Instacart app, remove the turkey penne items and add chicken wings, rice and veggies.",
    "If you want, I can try the swap again, or you can remove the turkey penne and add the Korean beef in the app.",
    "You could swap the rice for quinoa on the Instacart website.",
    "Remove the party cups in your cart and I'll check out.",
  ]) assert.ok(handsWorkBack(said), said);
  for (const said of [
    "I removed the turkey penne and added the wings in your Instacart cart.",
    "Tap Yes in the Instacart app on your phone, then text me.",
    "You can pay with the card Instacart already has in the app.",
    "Want me to remove the party cups too?",
  ]) assert.ok(!handsWorkBack(said), said);
  assert.match(HANDBACK_NOTICE, /a cart, an order, a booking/);
});

test("a picture check handed over is a captcha handed over", () => {
  const said = "A picture check keeps rejecting my answers, so I need you for that one step.";
  assert.equal(handsOverACaptcha(said), true);
  const claims = claimCheck({ question: "order my groceries" });
  claims.wrapWeb({ tools: [], usage: {}, call: async () => ({ content: [{ type: "text", text: "Sign in" }] }) });
  assert.equal(claims.check(said), CAPTCHA_NOTICE);
  assert.equal(handsOverACaptcha("Your order's in, with the puzzle box set you wanted."), false);
});

const web = (results) => ({
  tools: [],
  usage: {},
  call: async (name) => results[name] ?? { content: [{ type: "text", text: "ok" }] },
});

test("a browser call that failed, given up on, gets one round telling Tex to run it again", async () => {
  const said = "I couldn't change the cart. The Instacart cart won't open in my browser, so nothing is removed or added.";
  const claims = claimCheck({ question: "remove the deli chicken" });
  const wrapped = claims.wrapWeb(web({ browse: { content: [{ type: "text", text: "Steps: goto: not done" }], isError: true } }));
  await wrapped.call("browse", {});
  assert.equal(claims.check(said), BROWSER_RETRY_NOTICE);
  assert.notEqual(claims.check(said), BROWSER_RETRY_NOTICE, "once a turn");
  assert.match(BROWSER_RETRY_NOTICE, /never ask them to make the change themselves/);
});

test("a browser call that worked last is not sent round again", async () => {
  const said = "The deli chicken wouldn't load, so I picked rotisserie instead.";
  const claims = claimCheck({ question: "remove the deli chicken" });
  const results = { browse: { content: [{ type: "text", text: "ok" }], isError: true } };
  const wrapped = claims.wrapWeb(web(results));
  await wrapped.call("browse", {});
  delete results.browse;
  await wrapped.call("browse", {});
  assert.notEqual(claims.check(said), BROWSER_RETRY_NOTICE);
});

test("a stumble reads where the browser got to, rather than saying it couldn't", async () => {
  let calls = 0;
  const computer = {
    mayResume: () => true,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps) {
      calls += 1;
      if (calls === 2) throw new Error("the Worker dropped it");
      return {
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: "https://www.instacart.com/store/cart", title: "Cart", text: "26 items", truncated: false, elements: [] },
      };
    },
    async closeBrowser() {},
  };
  const session = webSession(computer, "edit my cart on https://www.instacart.com/store/cart");
  await session.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://www.instacart.com/store/cart" }] });
  const stumbled = await session.call(BROWSE_TOOL, { steps: [{ do: "click", text: "Remove" }] });
  assert.equal(calls, 3, "the failed steps, then one read");
  assert.equal(stumbled.isError, true);
  assert.match(stumbled.content[0].text, /26 items/);
  assert.match(stumbled.content[0].text, /stumbled/);
  assert.match(stumbled.content[0].text, /Never tell the person the page won't open/);
});
