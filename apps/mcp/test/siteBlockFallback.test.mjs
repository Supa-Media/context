import assert from "node:assert/strict";
import test from "node:test";
import { browserUseFlag, fallbackWanted, siteBlockAfterLadder } from "../src/agent/browserUseFallback.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

/**
 * A browse result the screenshot Worker would return. Invented. No page, no person.
 * `vendorStatus` is Browserbase refusing. `blocked` is the document host answering 403.
 */
function result(fields) {
  return { provider: "browserbase", reading: { url: "https://shop.example/check-in" }, ran: [{ do: "goto", ok: true }], ...fields };
}

/**
 * 2026-11-17: every 403 in a week of browse logs was Browserbase refusing the Verified tier, and a fallback that treated
 * that as a site block would have spent the day's cap on a plan limit. A document-host 403, a captcha that outlasted the
 * ladder, and a submit that never moved are the blocks a second browser is for. This was the replay case
 * `site-block-fallback` until the replay set reached its cap of 50 (2026-11-19); it is a plain check, so it runs here.
 */
test("a site block is told apart from a Browserbase refusal, and the fallback runs once when the flag is on", () => {
  assert.equal(browserUseFlag(TEX_CONFIG, {}), "off", "the committed config leaves the fallback off");
  assert.equal(browserUseFlag(TEX_CONFIG, { BROWSER_USE_FALLBACK: "on" }), "on", "a staging var is the only override");
  assert.equal(siteBlockAfterLadder(result({ vendorStatus: 403, tierRefused: true, blocked: { reason: "403" } })), null, "a Verified-tier 403 is Browserbase, even when a blocked field is also present");
  assert.equal(siteBlockAfterLadder(result({ vendorStatus: 402 })), null, "billing is not a site block");
  assert.equal(siteBlockAfterLadder(result({ vendorStatus: 503 })), null, "capacity is not a site block");
  assert.equal(siteBlockAfterLadder(result({ error: true })), null, "a generic error is not a site block");
  assert.equal(siteBlockAfterLadder(result({ blocked: { reason: "403", host: "shop.example" } })), "403");
  assert.equal(siteBlockAfterLadder(result({ captchaStuck: true, captchaKind: "wall" })), "interstitial");
  assert.equal(siteBlockAfterLadder(result({ captchaStuck: true, captchaKind: "widget" })), "captcha");
  assert.equal(siteBlockAfterLadder(result({ submitStuck: true })), "stuck_submit");
  assert.equal(fallbackWanted({ flag: "off", reason: "403", already: false }), false, "the flag off does not retry");
  assert.equal(fallbackWanted({ flag: "on", reason: "403", already: false }), true);
  assert.equal(fallbackWanted({ flag: "on", reason: "403", already: true }), false, "one fallback per question");
});
