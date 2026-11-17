/**
 * The gateway decides a Browser Use retry. The flag off changes nothing.
 * A Verified-tier 403 from Browserbase does not trigger one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { STUCK_LINE } from "../src/agent/captchaLadder.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";
import { browserUseFlag, fallbackWanted, siteBlockAfterLadder } from "../src/agent/browserUseFallback.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

const PAGE = "https://wwws.airfrance.com/check-in";
const OWNER = "a".repeat(64);

test("the committed flag is off, and a staging var is the only override", () => {
  assert.equal(TEX_CONFIG.browsers.browserUseFallback, "off");
  assert.equal(browserUseFlag(TEX_CONFIG, {}), "off");
  assert.equal(browserUseFlag(TEX_CONFIG, { BROWSER_USE_FALLBACK: "on" }), "on");
  assert.deepEqual(
    { jobMinutes: TEX_CONFIG.browsers.jobMinutes, dayUsd: TEX_CONFIG.browsers.dayUsd, monthUsd: TEX_CONFIG.browsers.monthUsd, minBalanceUsd: TEX_CONFIG.browsers.minBalanceUsd },
    { jobMinutes: 15, dayUsd: 1, monthUsd: 5, minBalanceUsd: 0.5 },
  );
});

test("a Verified-tier 403, billing 402, capacity 503 and a generic error do not trigger", () => {
  assert.equal(siteBlockAfterLadder({ vendorStatus: 403, tierRefused: true }), null);
  assert.equal(siteBlockAfterLadder({ vendorStatus: 403, blocked: { reason: "403", host: "api.browserbase.com" } }), null);
  assert.equal(siteBlockAfterLadder({ vendorStatus: 402 }), null);
  assert.equal(siteBlockAfterLadder({ vendorStatus: 503 }), null);
  assert.equal(siteBlockAfterLadder({ error: true }), null);
  assert.equal(fallbackWanted({ flag: "on", reason: siteBlockAfterLadder({ tierRefused: true, vendorStatus: 403 }), already: false }), false);
});

test("a document 403, an unsolved captcha, an interstitial and a stuck submit do trigger", () => {
  assert.equal(siteBlockAfterLadder({ blocked: { reason: "403", host: "wwws.airfrance.com" } }), "403");
  assert.equal(siteBlockAfterLadder({ captchaStuck: true, captchaKind: "widget" }), "captcha");
  assert.equal(siteBlockAfterLadder({ captchaStuck: true, captchaKind: "wall" }), "interstitial");
  assert.equal(siteBlockAfterLadder({ captchaStuck: true }), "captcha");
  assert.equal(siteBlockAfterLadder({ submitStuck: true }), "stuck_submit");
  assert.equal(fallbackWanted({ flag: "off", reason: "403", already: false }), false);
  assert.equal(fallbackWanted({ flag: "on", reason: "403", already: true }), false);
  assert.equal(fallbackWanted({ flag: "on", reason: "403", already: false }), true);
});

function blockedComputer(flag) {
  const calls = [];
  return {
    calls,
    browserUseFallback: () => flag,
    canHandOff: () => true,
    mayResume: () => true,
    async browse(_session, steps, options = {}) {
      calls.push({ provider: options.provider ?? "browserbase", steps: steps.map((step) => step.do) });
      if (options.provider === "browser-use") {
        return {
          provider: "browser-use",
          session: "bu-1",
          ran: steps.map((step) => ({ do: step.do, ok: true })),
          page: { url: PAGE, title: "Check-in", text: "Booking reference", elements: [] },
          ms: 800,
          costUsd: 0.01,
        };
      }
      return {
        provider: "browserbase",
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Blocked", text: "", elements: [] },
        blocked: { reason: "403", host: "wwws.airfrance.com" },
        ms: 400,
      };
    },
    async closeBrowser() {},
  };
}

test("the flag off does not call Browser Use when the document host returned 403", async () => {
  const computer = blockedComputer("off");
  const web = webSession(computer, `open ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });
  assert.deepEqual(computer.calls.map((call) => call.provider), ["browserbase"]);
  assert.equal(result.content[0].text.includes("other browser"), false);
});

test("the flag on retries that 403 once and does not loop", async () => {
  const computer = blockedComputer("on");
  const web = webSession(computer, `open ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });
  assert.deepEqual(computer.calls.map((call) => call.provider), ["browserbase", "browser-use"]);
  assert.match(result.content[0].text, /Booking reference/);
  assert.equal(result.captchaStuck, undefined);
  const again = await web.call(BROWSE_TOOL, { steps: [{ do: "read" }] });
  assert.equal(again.content[0].text.includes("Blocked") || again.content[0].text.includes("Booking"), true);
  assert.equal(computer.calls.filter((call) => call.provider === "browser-use").length, 1);
});

test("a refused fallback keeps the Browserbase result and says why", async () => {
  const calls = [];
  const computer = {
    calls,
    browserUseFallback: () => "on",
    canHandOff: () => false,
    mayResume: () => true,
    async browse(_session, steps, options = {}) {
      calls.push(options.provider ?? "browserbase");
      if (options.provider === "browser-use") return { refused: "browser-use day cap reached ($1)" };
      return {
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Blocked", text: "Access denied", elements: [] },
        blocked: { reason: "403", host: "wwws.airfrance.com" },
      };
    },
    async closeBrowser() {},
  };
  const web = webSession(computer, `open ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });
  assert.match(result.content[0].text, /Access denied/);
  assert.match(result.content[0].text, /browser-use day cap reached \(\$1\)/);
  assert.deepEqual(calls, ["browserbase", "browser-use"]);
});

test("the screenshot computer sends provider browser-use only when the flag is on, and never a profile", async () => {
  resetBrowserbaseProbe();
  const posts = [];
  const binding = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.provider === "browser-use") {
        return Response.json({ fallbackRefused: true, reason: "browser-use balance could not be read" });
      }
      return Response.json({
        provider: "browserbase",
        session: "bb-1",
        ran: [{ do: "read", ok: true }],
        page: { url: PAGE, title: "Page", text: "Hi", elements: [] },
      });
    },
  };
  const off = siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "off" });
  await off.browse(null, [{ do: "goto", url: PAGE }], { provider: "browser-use" });
  assert.equal(posts[0].provider, "browserbase");
  assert.equal(posts[0].profile, undefined);

  resetBrowserbaseProbe();
  const on = siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "on" });
  const refused = await on.browse(null, [{ do: "goto", url: PAGE }], { provider: "browser-use" });
  assert.equal(refused.refused, "browser-use balance could not be read");
  const sent = posts.at(-1);
  assert.equal(sent.provider, "browser-use");
  assert.equal(sent.profile, undefined);
  assert.equal(sent.caps.jobMinutes, 15);
  assert.equal(sent.caps.dayUsd, 1);
  assert.equal(sent.caps.monthUsd, 5);
  assert.equal(sent.caps.minBalanceUsd, 0.5);
  assert.equal(JSON.stringify(sent).includes("liveUrl"), false);
  resetBrowserbaseProbe();
});

/**
 * A click that does not itself open the page. The browser is already on PAGE
 * from an earlier call. A fallback has to open that page and redo the steps
 * already done before it clicks again: the other browser starts blank.
 */
test("a plan that does not open a page replays the open and the steps already done first", async () => {
  const calls = [];
  const computer = {
    calls,
    browserUseFallback: () => "on",
    canHandOff: () => true,
    mayResume: () => true,
    async browse(_session, steps, options = {}) {
      calls.push({ provider: options.provider ?? "browserbase", steps });
      if (options.provider === "browser-use") {
        return {
          provider: "browser-use",
          session: "bu-1",
          ran: steps.map((step) => ({ do: step.do, ok: true })),
          page: { url: PAGE, title: "Check-in", text: "Booking reference", elements: [] },
        };
      }
      const blocked = steps.some((step) => step.do === "click");
      return {
        provider: "browserbase",
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: blocked ? "Blocked" : "Check-in", text: blocked ? "" : "Booking reference", elements: [{ ref: 1, kind: "input text", label: "Name" }, { ref: 4, kind: "button", label: "Register" }] },
        ...(blocked ? { blocked: { reason: "403", host: "wwws.airfrance.com" } } : {}),
      };
    },
    async closeBrowser() {},
  };
  const web = webSession(computer, `open ${PAGE}, type Maya, then click Register`);
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }, { do: "type", ref: 1, text: "Maya" }] });
  await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
  const fallback = calls.find((call) => call.provider === "browser-use");
  assert.ok(fallback, "the blocked click was tried on Browser Use");
  assert.deepEqual(fallback.steps.map((step) => step.do), ["goto", "type", "click"], "the blank browser opens the page and redoes the steps already done, then this call");
  assert.equal(fallback.steps[0].url, PAGE);
  assert.equal(fallback.steps[1].text, "Maya");
  assert.equal(fallback.steps[2].ref, 4);
});

/**
 * The other browser's click fails because it is still on a blank page. That
 * is not a cleared block: the hand-off stays, and the log does not say ok.
 */
test("a fallback whose step fails is not cleared and does not cancel the hand-off", async () => {
  const calls = [];
  const rows = [];
  const said = [];
  const computer = {
    calls,
    rows,
    browserUseFallback: () => "on",
    canHandOff: () => true,
    mayResume: () => true,
    async noteBrowse(row) {
      rows.push(row);
    },
    async browse(_session, steps, options = {}) {
      calls.push({ provider: options.provider ?? "browserbase", steps: steps.map((step) => step.do), handoff: options.handoff === true });
      if (options.provider === "browser-use") {
        return {
          provider: "browser-use",
          session: "bu-1",
          ran: steps.map((step) => ({ do: step.do, ok: step.do !== "click", ...(step.do === "click" ? { reason: "no such element" } : {}) })),
          page: { url: "about:blank", title: "", text: "BLANK_BROWSER", elements: [] },
        };
      }
      return {
        provider: "browserbase",
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: {
          url: PAGE,
          title: "Check-in",
          text: "Verify you are human",
          elements: [{ ref: 4, kind: "button", label: "Register" }],
        },
        ...(options.handoff ? { handoffUrl: "https://context.lc/tex/maya" } : { captcha: "unsolved", captchaKind: "widget" }),
      };
    },
    async closeBrowser() {},
  };
  const web = webSession(computer, `open ${PAGE} and click Register`, { say: async (line) => (said.push(line), true) });
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }, { do: "click", ref: 4 }, { do: "handoff" }] });
  assert.equal(rows.at(-1)?.fallback?.outcome, "steps_failed");
  assert.equal(rows.at(-1)?.fallback?.step, "click");
  assert.equal(result.captchaStuck, true);
  assert.match(result.content[0].text, /Verify you are human/);
  assert.equal(result.content[0].text.includes("BLANK_BROWSER"), false);
  assert.ok(result.content[0].text.includes(STUCK_LINE));
  assert.equal(said.length, 1);
  assert.match(said[0], /wwws\.airfrance\.com/);
  assert.equal(calls.at(-1)?.handoff, true);
  assert.equal(calls.at(-1)?.provider, "browserbase");
});

test("a failed fallback releases Browser Use and leaves the question on Browserbase", async () => {
  resetBrowserbaseProbe();
  let browserUseOpen = false;
  const posts = [];
  const binding = {
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      if (path === "/browse/close" && body.provider === "browser-use") {
        browserUseOpen = false;
        return Response.json({ closed: true });
      }
      if (path === "/browse/log" || path === "/browse/hold" || path === "/browse/release") return Response.json({ ok: true });
      if (body.provider === "browser-use") {
        browserUseOpen = true;
        const steps = body.steps ?? [];
        return Response.json({
          provider: "browser-use",
          session: "bu-1",
          ran: steps.map((step) => ({ do: step.do, ok: step.do !== "click" })),
          page: { url: "about:blank", title: "", text: "BLANK_BROWSER", elements: [] },
        });
      }
      return Response.json({
        provider: "browserbase",
        session: "bb-1",
        ran: (body.steps ?? []).map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Blocked", text: "Access denied", elements: [{ ref: 4, kind: "button", label: "Register" }] },
        blocked: { reason: "403", host: "wwws.airfrance.com" },
      });
    },
  };
  const computer = siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "on", viewer: "https://context.lc/tex/maya" });
  const web = webSession(computer, `open ${PAGE} and click Register`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
  const fallback = posts.find((post) => post.path === "/browse" && post.body.provider === "browser-use");
  assert.equal(fallback?.body.steps[0]?.do, "goto");
  assert.equal(fallback?.body.steps[0]?.url, PAGE);
  const logged = posts.find((post) => post.path === "/browse/log");
  assert.equal(logged?.body.fallback?.outcome, "steps_failed");
  assert.equal(logged?.body.fallback?.step, "click");
  assert.equal(logged?.body.provider, "browserbase");
  assert.match(result.content[0].text, /Access denied/);
  assert.equal(result.content[0].text.includes("BLANK_BROWSER"), false);
  assert.equal(browserUseOpen, false, "the Browser Use session was released, so the live view stays on Browserbase");
  assert.equal(posts.filter((post) => post.path === "/browse/close" && post.body.provider === "browser-use").length, 1);
  posts.length = 0;
  await computer.browse("bb-1", [{ do: "read" }]);
  assert.equal(posts.at(-1)?.body.provider, "browserbase", "the rest of the question stays on Browserbase");
  await computer.closeBrowser("bb-1", { waiting: true });
  assert.equal(posts.some((post) => post.path === "/browse/hold" && post.body.provider === "browserbase"), true);
  assert.equal(posts.some((post) => post.path === "/browse/hold" && post.body.provider === "browser-use"), false);
  resetBrowserbaseProbe();
});

test("a cleared fallback keeps the rest of the question on Browser Use", async () => {
  resetBrowserbaseProbe();
  const posts = [];
  const binding = {
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      if (path === "/browse/log" || path === "/browse/hold" || path === "/browse/close" || path === "/browse/release") return Response.json({ ok: true });
      if (body.provider === "browser-use") {
        return Response.json({
          provider: "browser-use",
          session: "bu-1",
          ran: (body.steps ?? []).map((step) => ({ do: step.do, ok: true })),
          page: { url: PAGE, title: "Check-in", text: "Booking reference", elements: [] },
          costUsd: 0.01,
        });
      }
      return Response.json({
        provider: "browserbase",
        session: "bb-1",
        ran: (body.steps ?? []).map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Blocked", text: "", elements: [] },
        blocked: { reason: "403", host: "wwws.airfrance.com" },
      });
    },
  };
  const computer = siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "on" });
  const web = webSession(computer, `open ${PAGE}`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });
  assert.match(result.content[0].text, /Booking reference/);
  assert.equal(posts.some((post) => post.path === "/browse/close" && post.body.provider === "browser-use"), false);
  posts.length = 0;
  await computer.browse("bb-1", [{ do: "read" }]);
  assert.equal(posts.at(-1)?.body.provider, "browser-use");
  resetBrowserbaseProbe();
});

test("the flag off does not ask the browse to wait for the session log", async () => {
  resetBrowserbaseProbe();
  const posts = [];
  const binding = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      posts.push(body);
      return Response.json({
        provider: "browserbase",
        session: "bb-1",
        ran: (body.steps ?? []).map((step) => ({ do: step.do, ok: true })),
        page: { url: PAGE, title: "Page", text: "Hi", elements: [] },
      });
    },
  };
  await siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "off" }).browse(null, [{ do: "goto", url: PAGE }]);
  assert.equal(posts[0].provider, "browserbase");
  assert.equal(posts[0].waitForBlock, undefined);
  resetBrowserbaseProbe();
  await siteShotsComputer({ SITE_SHOTS: binding }, { owner: OWNER, browserUse: "on" }).browse(null, [{ do: "read" }]);
  assert.equal(posts.at(-1).provider, "browserbase");
  assert.equal(posts.at(-1).waitForBlock, true);
  resetBrowserbaseProbe();
});
