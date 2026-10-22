/**
 * A captcha is the person's only after every way past it was tried
 * (`src/agent/captchaLadder.js`; the owner, 2026-10-22: "make sure agents try
 * using those bypasses and other browserbase hacks before handing back").
 * Browserbase's solver has already had its wait in the screenshot Worker when
 * a run answers `captcha: "unsolved"`; the gateway then reloads the page, then
 * starts a fresh browser, and only a captcha that outlasts both may be handed
 * over.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-22).
 *
 *  1. `captchaLadder` without the fresh-browser try. → "when a reload is not
 *     enough, a fresh browser with a new address is tried" and "only a
 *     captcha that outlasts …" fail.
 *  2. `claimCheck` never giving `CAPTCHA_NOTICE`. → "a captcha handed over
 *     before the browser's tries gets one more round" fails.
 *  3. `browse.js` handing over after the tries cleared the captcha. → "a
 *     captcha the solver could not clear is reloaded …" fails.
 *  4. `captchaPending` always false (infra/site-shots). → three tests in
 *     captcha.test.ts fail.
 *  5. `captchaLadder` forgetting the pages it gave up on. → "once a page's
 *     captcha outlasted every try, the handoff … does not try again" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { STUCK_LINE, MAX_LADDERS_PER_TURN } from "../src/agent/captchaLadder.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";
import { CAPTCHA_NOTICE, claimCheck, handsOverACaptcha } from "../src/agent/claimCheck.js";

const PAGE = "https://shop.example.com/checkout";

/**
 * A Browserbase-like computer whose runs answer `captchas` in order (the last
 * repeats): "unsolved", "solved" or null for none. Every call is recorded with
 * its options.
 */
function captchaComputer(captchas) {
  const calls = [];
  return {
    calls,
    canHandOff: () => true,
    mayResume: () => true,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps, options = {}) {
      const captcha = captchas[Math.min(calls.length, captchas.length - 1)];
      calls.push({ steps: steps.map((s) => s.do), fresh: options.fresh === true, handoff: options.handoff === true });
      return {
        session: "bb-captcha",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Checkout", text: "", truncated: false, elements: [] },
        ...(captcha ? { captcha } : {}),
        ...(options.handoff ? { handoffUrl: "https://context.lc/tex/maya" } : {}),
      };
    },
    async closeBrowser() {},
  };
}

const open = { steps: [{ do: "goto", url: PAGE }] };
const openAndHandOver = { steps: [{ do: "goto", url: PAGE }, { do: "handoff" }] };

test("a captcha the solver could not clear is reloaded, and a cleared one is never handed over", async () => {
  const computer = captchaComputer(["unsolved", null]);
  const web = webSession(computer, `book a court on ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, openAndHandOver);
  assert.deepEqual(computer.calls.map((c) => [c.steps.join(","), c.fresh, c.handoff]), [["goto", false, false], ["goto", false, false]]);
  assert.match(result.content[0].text, /Browserbase's solver, after a reload, got past it/);
  assert.match(result.content[0].text, /never ask the person to solve a captcha/);
  assert.equal(web.browser.handoffLine(), null, "nothing was handed over");
  assert.equal(result.captchaStuck, undefined);
});

test("when a reload is not enough, a fresh browser with a new address is tried", async () => {
  const computer = captchaComputer(["unsolved", "unsolved", null]);
  const web = webSession(computer, `book a court on ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, open);
  assert.deepEqual(computer.calls.map((c) => c.fresh), [false, false, true]);
  assert.match(result.content[0].text, /a fresh browser with a new address got past it/);
});

test("only a captcha that outlasts the solver, a reload and a fresh browser is handed over", async () => {
  const computer = captchaComputer(["unsolved"]);
  const web = webSession(computer, `book a court on ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, openAndHandOver);
  assert.deepEqual(computer.calls.map((c) => [c.steps.join(","), c.fresh, c.handoff]), [
    ["goto", false, false],
    ["goto", false, false],
    ["goto", true, false],
    ["read", false, true],
  ]);
  assert.ok(result.content[0].text.includes(STUCK_LINE));
  assert.equal(result.captchaStuck, true);
  assert.match(web.browser.handoffLine(), /context\.lc\/tex\/maya/);
});

test("once a page's captcha outlasted every try, the handoff the model then asks for does not try again", async () => {
  const computer = captchaComputer(["unsolved"]);
  const web = webSession(computer, `book a court on ${PAGE}`);
  await web.call(BROWSE_TOOL, open);
  assert.equal(computer.calls.length, 3, "the reload and the fresh browser were tried");
  const handing = await web.call(BROWSE_TOOL, { steps: [{ do: "handoff" }] });
  assert.deepEqual(computer.calls.slice(3).map((c) => [c.steps.join(","), c.fresh, c.handoff]), [
    ["read", false, false],
    ["read", false, true],
  ]);
  assert.ok(handing.content[0].text.includes(STUCK_LINE));
  assert.match(web.browser.handoffLine(), /context\.lc\/tex\/maya/);
});

test("a handoff with no captcha (a sign-in) runs no tries", async () => {
  const computer = captchaComputer([null]);
  const web = webSession(computer, `sign in on ${PAGE}`);
  await web.call(BROWSE_TOOL, openAndHandOver);
  assert.deepEqual(computer.calls.map((c) => [c.steps.join(","), c.handoff]), [["goto", false], ["read", true]]);
  assert.match(web.browser.handoffLine(), /context\.lc\/tex\/maya/);
});

test("one question runs the tries on at most two pages; a later captcha is the person's at once", async () => {
  const computer = captchaComputer(["unsolved"]);
  const web = webSession(computer, `book a court on ${PAGE}`);
  for (let i = 0; i < MAX_LADDERS_PER_TURN; i += 1) await web.call(BROWSE_TOOL, open);
  const before = computer.calls.length;
  const result = await web.call(BROWSE_TOOL, open);
  assert.equal(computer.calls.length - before, 1, "no more tries");
  assert.ok(result.content[0].text.includes(STUCK_LINE));
});

test("a fresh browser is asked of the screenshot Worker by name", async () => {
  resetBrowserbaseProbe();
  const bodies = [];
  const binding = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json({ session: "bb-1", ran: [], page: { url: PAGE, title: "", text: "", truncated: false, elements: [] } });
    },
  };
  const computer = siteShotsComputer({ SITE_SHOTS: binding }, { owner: "a".repeat(64), viewer: "https://context.lc/tex/maya" });
  await computer.browse(null, [{ do: "goto", url: PAGE }], { fresh: true });
  await computer.browse("bb-1", [{ do: "read" }]);
  assert.equal(bodies[0].fresh, true);
  assert.equal(bodies[1].fresh, undefined);
  resetBrowserbaseProbe();
});

/* ------------- The answer check: a captcha handed over before the tries ------------- */


test("an answer that hands them a captcha is read as one; one that got past it is not", () => {
  for (const said of [
    "Riverside's site wants a captcha, so tap the link and solve it and I'll book 9am.",
    "Tap here and tick the box to prove you're not a robot.",
    "Solve the captcha on the booking page for me.",
  ]) assert.equal(handsOverACaptcha(said), true, said);
  for (const said of [
    "I got past the captcha and booked Court 3 for 9am.",
    "The captcha took a while but I solved it and booked Court 3.",
    "Booked Court 3, Sat 9 to 10am.",
  ]) assert.equal(handsOverACaptcha(said), false, said);
});

test("a captcha handed over before the browser's tries gets one more round; after them it goes", async () => {
  const said = "Riverside's site wants a captcha, so tap the link and solve it and I'll book 9am.";
  const browse = (stuck) => ({ tools: [], usage: {}, call: async () => ({ content: [{ type: "text", text: "Checkout" }], ...(stuck ? { captchaStuck: true } : {}) }) });

  const untried = claimCheck({ question: "book me a court at riverside" });
  untried.wrapWeb(browse(false));
  assert.equal(untried.check(said), CAPTCHA_NOTICE);
  assert.equal(untried.check(said), null, "once a turn");

  const cleared = claimCheck({ question: "book me a court at riverside" });
  await cleared.wrapWeb(browse(false)).call("browse", { steps: [{ do: "goto", url: PAGE }] });
  assert.equal(cleared.check(said), CAPTCHA_NOTICE, "a page with no captcha left is not one to hand over");

  const stuck = claimCheck({ question: "book me a court at riverside" });
  await stuck.wrapWeb(browse(true)).call("browse", { steps: [{ do: "goto", url: PAGE }] });
  assert.equal(stuck.check(said), null, "a captcha that outlasted every try is theirs");
});
