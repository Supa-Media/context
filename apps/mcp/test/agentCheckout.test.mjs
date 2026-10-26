/**
 * A CHECKOUT TEX FINISHES ITSELF (the owner's review, 2026-10-26: a Vamoose
 * bus booking). A seat-map popup covered the page, the card boxes, terms box
 * and Purchase button sat past the reading's 80th element, Tex texted its
 * browser twice to someone who then refused it, told them to type the card
 * and press Purchase, said a site lacked times it had never searched, ended a
 * job on "Next I'll ...", and texted a paragraph of a bug report to 👍.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-26).
 *
 *  1. `shownElements` listing only the first 80. → "a long checkout lists
 *     every box and button past the 80th" fails.
 *  2. `browse.js` passing `from` on to the browser. → "a read step with from
 *     lists from that number, and the browser just reads" fails.
 *  3. The handoff step ignoring `handoffRefused`. → "a browser they refused
 *     is never handed over again" fails.
 *  4. `claimCheck` without the `CARD_NOTICE` check. → "telling them to type
 *     the card and press Purchase gets one more round" fails.
 *  5. `claimCheck` without the `!browserTried` condition on the site check.
 *     → "a site searched in the browser this turn may say what it lacks"
 *     fails.
 *  6. `unfinishedJob` without `announcesNextStep`. → "a job that ends on its
 *     own next step is not done" fails.
 *  7. `TEXTED_REPORT_CAP` back at 2,000. → "a texted bug report is a few
 *     sentences" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { browserSession, handoffRefusedIn, shownElements } from "../src/agent/browse.js";
import { CARD_NOTICE, LOOK_ON_SITE_NOTICE, handsBackThePayment, saysNotFoundOnSite } from "../src/agent/checkoutChecks.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { announcesNextStep, unfinishedJob } from "../src/agent/stopsShort.js";
import { TEXTED_REPORT_CAP, reportGate } from "../src/tools/reportGate.js";

/** A bus checkout: a long schedule of links, then the passenger and card boxes and the Purchase button. */
function checkoutElements() {
  const links = Array.from({ length: 110 }, (_, i) => ({ ref: i + 1, kind: "link", label: `Route ${i + 1}`, href: `https://www.vamoosebus.example/r/${i + 1}` }));
  const boxes = [
    { ref: 111, kind: "input text", label: "First name" },
    { ref: 112, kind: "input text", label: "Card number" },
    { ref: 113, kind: "select", label: "Month (now: MM)" },
    { ref: 114, kind: "select", label: "Year (now: YYYY)" },
    { ref: 115, kind: "input text", label: "Card Owner Name" },
    { ref: 116, kind: "input checkbox", label: "I agree to the terms", checked: false },
    { ref: 117, kind: "button", label: "Purchase now" },
  ];
  return [...links, ...boxes, { ref: 118, kind: "link", label: "Privacy" }];
}

test("a long checkout lists every box and button past the 80th", () => {
  const { shown, more } = shownElements(checkoutElements());
  const labels = shown.map((element) => element.label);
  for (const label of ["Card number", "Month (now: MM)", "Card Owner Name", "I agree to the terms", "Purchase now"]) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes("Route 81"), "links past the first ones wait for a read with from");
  assert.match(more, /31 more links not listed, from \[81\]: a read step with from: 81/);
});

test("a short page lists everything, with no line about more", () => {
  const { shown, more } = shownElements(checkoutElements().slice(0, 20));
  assert.equal(shown.length, 20);
  assert.equal(more, "");
});

/** A browser that serves the checkout, records each call's steps, and can be handed over. */
function fakeComputer({ popup = false } = {}) {
  const calls = [];
  return {
    calls,
    canHandOff: () => true,
    mayResume: () => true,
    async browse(session, steps, options) {
      calls.push({ steps, options });
      return {
        session: "bb-session-0001",
        ran: steps.map((step) => ({ do: step.do, ok: true, ...(step.do === "close_popup" ? { reason: "pressed its close button" } : {}) })),
        page: { url: "https://www.vamoosebus.example/checkout.aspx", title: "Checkout", text: "Seats Selection", truncated: false, elements: checkoutElements(), ...(popup ? { popup: true } : {}) },
      };
    },
  };
}

function session(computer, extra = {}) {
  return browserSession(computer, { allowed: new Set(["https://www.vamoosebus.example/checkout.aspx"]), addresses: "book them", takePages: () => true, ...extra });
}

const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("a read step with from lists from that number, and the browser just reads", async () => {
  const computer = fakeComputer();
  const result = await session(computer).call({ steps: [{ do: "read", from: 81 }] });
  assert.deepEqual(computer.calls[0].steps, [{ do: "read" }]);
  const said = textOf(result);
  assert.match(said, /What you can press or type into, from \[81\]:/);
  assert.match(said, /\[81\] link: Route 81/);
  assert.doesNotMatch(said, /\[80\] link/);
});

test("a popup over the page is said, and close_popup goes to the browser as it is", async () => {
  const computer = fakeComputer({ popup: true });
  const result = await session(computer).call({ steps: [{ do: "close_popup", ref: 4 }] });
  assert.deepEqual(computer.calls[0].steps, [{ do: "close_popup" }]);
  const said = textOf(result);
  assert.match(said, /close_popup: done \(pressed its close button\)/);
  assert.match(said, /Something is drawn over this page/);
  assert.match(session(computer).definition.description, /close_popup step closes it/);
});

test("their texts refusing the browser are read as a refusal, and other words are not", () => {
  for (const said of [
    "If you can't book this bus for me yourself, you are useless to me, im not opening your browser",
    "I'm not going to open your link",
    "stop sending me your browser",
    "I won’t use your browser, just do it",
    "dont send me the link to your browser",
  ]) {
    assert.ok(handoffRefusedIn(said), said);
  }
  for (const said of ["I just see a blank white screen", "open the link and pay", "I'm not sure which bus", "Done, I'm signed in", "don't book the 11 am"]) {
    assert.equal(handoffRefusedIn(said), false, said);
  }
});

test("a browser they refused is never handed over again", async () => {
  const computer = fakeComputer();
  const said = [];
  const refused = session(computer, { handoffRefused: true, say: async (line) => said.push(line) });
  const result = await refused.call({ steps: [{ do: "handoff" }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /won't take over your browser/);
  assert.equal(computer.calls.length, 0);
  assert.deepEqual(said, []);
  assert.equal(refused.handoffLine(), null);
  assert.doesNotMatch(refused.definition.description, /add a handoff step/);
  assert.match(refused.definition.description, /never offer or send them a link to it/);
  // And with no refusal, the handoff is still there.
  assert.match(session(fakeComputer()).definition.description, /add a handoff step/);
});

const PAY_YOURSELF =
  "I just texted you a link to my browser, and the cart has about a minute left. Put in your Chase Visa ending 4813, tick the terms box and press Purchase now ($131.50). Then text me.";

test("the review's payment hand-back is read as one, and a total with the card ask is not", () => {
  assert.ok(handsBackThePayment(PAY_YOURSELF));
  assert.ok(handsBackThePayment("Enter your card details, then press Pay."));
  for (const said of [
    "Both buses are in the cart, $131.50 with the fee. Allow the Chase Visa ending 4813 and I'll pay.",
    "Paid. Your confirmation number is VB-2231.",
    "There's no card saved, so here's a link to save one: https://context.lc/vault/add",
    "Give it a 👍 and I'll fill in the card.",
    "Once you allow it, I'll tick the terms box and press Purchase now.",
  ]) {
    assert.equal(handsBackThePayment(said), false, said);
  }
});

const web = (tools) => ({ tools, usage: {}, call: async () => ({ content: [{ type: "text", text: "ok" }] }) });
const WEB_TOOLS = [{ name: "browse" }, { name: "fill_card" }, { name: "open_page" }, { name: "search_web" }];

test("telling them to type the card and press Purchase gets one more round", () => {
  const claims = claimCheck({ question: "book it" });
  claims.wrapWeb(web(WEB_TOOLS));
  assert.equal(claims.check(PAY_YOURSELF), CARD_NOTICE);
  assert.notEqual(claims.check(PAY_YOURSELF), CARD_NOTICE, "once a turn");
  // A turn that can't fill a card isn't told to.
  const bare = claimCheck({ question: "book it" });
  bare.wrapWeb(web([{ name: "browse" }]));
  assert.notEqual(bare.check(PAY_YOURSELF), CARD_NOTICE);
});

const NOT_SEARCHED =
  "I couldn't find the Sunday, Nov 1 times on Vamoose's site. A third-party listing shows a Monday, Nov 2 bus at 5:30 pm for $58, so the Sunday schedule still needs checking at vamoosebus.com.";

test("a site said to lack what the browser never searched is sent back to look", async () => {
  assert.ok(saysNotFoundOnSite(NOT_SEARCHED));
  assert.ok(saysNotFoundOnSite("The return times still need checking on their website."));
  assert.equal(saysNotFoundOnSite("Vamoose runs from Penn Station to Bethesda in about 4 hours."), false);
  const claims = claimCheck({ question: "isn't there a vamoose bus" });
  const wrapped = claims.wrapWeb(web(WEB_TOOLS));
  await wrapped.call("open_page", {});
  assert.equal(claims.check(NOT_SEARCHED), LOOK_ON_SITE_NOTICE);
});

test("a site searched in the browser this turn may say what it lacks", async () => {
  const claims = claimCheck({ question: "isn't there a vamoose bus" });
  const wrapped = claims.wrapWeb(web(WEB_TOOLS));
  await wrapped.call("browse", {});
  assert.notEqual(claims.check("I couldn't find a Sunday, Nov 1 bus on Vamoose's booking page: it lists Saturday and Monday only."), LOOK_ON_SITE_NOTICE);
});

test("a job that ends on its own next step is not done", () => {
  const said =
    "I still can't finish. The cart is set at $131.50 for both Sunday, Nov 1 buses, but the browser won't type your name.\n\n" +
    "Next I'll reload the checkout, fill in the passenger details, and then ask you to allow the Chase card before I press pay.";
  assert.ok(announcesNextStep(said));
  assert.ok(unfinishedJob({ attempt: 1 }, said));
  assert.equal(unfinishedJob(null, said), false);
  for (const fine of ["Both buses are booked. Next I'll text you the confirmation when Vamoose emails it.", "Next Sunday works for both buses."]) {
    assert.equal(announcesNextStep(fine), false, fine);
  }
});

test("a texted bug report is a few sentences", async () => {
  assert.ok(TEXTED_REPORT_CAP <= 500);
  const long = "Tex can't finish a bus booking. ".repeat(20);
  const refused = await reportGate({ message: long, share_texts: true }, { store: null, session: { egress: { texting: true } } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /two or three plain sentences/);
});
