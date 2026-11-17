/**
 * The gateway decides a Browser Use retry. The flag off changes nothing.
 * A Verified-tier 403 from Browserbase does not trigger one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
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
