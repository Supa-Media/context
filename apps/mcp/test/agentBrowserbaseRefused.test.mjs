/**
 * BROWSERBASE REFUSING FOR BILLING NEVER LEAVES TEX WITHOUT A BROWSER.
 *
 * On 2026-10-14 every texted browser job failed: Browserbase answered
 * "402 Payment Required" to each new session, the screenshot Worker turned
 * that into a 503, and the gateway only fell back to Cloudflare's browser on
 * a 501. Now a 402 hands this question to Cloudflare's browser, and the
 * isolate leaves Browserbase alone for a while instead of asking every call.
 *
 * ## Sabotage record
 *
 *   `browse` treating 402 like any other answer
 *     → "a 402 from Browserbase falls back to Cloudflare's browser" fails
 *   the refusal never expiring
 *     → "Browserbase is asked again once the pause is over" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BROWSERBASE_REFUSED_PAUSE_MS, resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";

const OWNER = "a".repeat(64);

function binding(answers) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ path: new URL(url).pathname, provider: body.provider ?? null });
      if (body.provider === "browserbase") {
        if (answers.browserbase === 402) return Response.json({ error: "browserbase refused: payment required" }, { status: 402 });
        return Response.json({ session: "bb-1", ran: [], page: null });
      }
      return Response.json({ session: "cf-1", ran: [{ do: "read", ok: true }], page: { url: "https://x.example/", title: "X", text: "", elements: [] } });
    },
  };
}

test("a 402 from Browserbase falls back to Cloudflare's browser", async () => {
  resetBrowserbaseProbe();
  const answers = { browserbase: 402 };
  const SITE_SHOTS = binding(answers);
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER, viewer: "https://app.example/tex/me" });
  const result = await computer.browse(null, [{ do: "read" }]);
  assert.equal(result.session, "cf-1");
  assert.deepEqual(SITE_SHOTS.requests.map((r) => r.provider), ["browserbase", null]);
  // Cloudflare's browser can't be handed over, and it closes with the question.
  assert.equal(computer.canHandOff(), false);
  assert.equal(computer.mayResume(), false);
  await computer.closeBrowser("cf-1");
  assert.equal(SITE_SHOTS.requests.at(-1).path, "/browse/close");
  // The next call in this isolate doesn't ask Browserbase again.
  await computer.browse("cf-1", [{ do: "read" }]);
  assert.deepEqual(SITE_SHOTS.requests.filter((r) => r.path === "/browse").map((r) => r.provider), ["browserbase", null, null]);
});

test("Browserbase is asked again once the pause is over", async () => {
  resetBrowserbaseProbe();
  const answers = { browserbase: 402 };
  const SITE_SHOTS = binding(answers);
  const start = Date.now();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER, viewer: null, now: () => clock });
  let clock = start;
  await computer.browse(null, [{ do: "read" }]);
  answers.browserbase = 200;
  clock = start + BROWSERBASE_REFUSED_PAUSE_MS + 1;
  const result = await computer.browse(null, [{ do: "read" }]);
  assert.equal(result.session, "bb-1");
});
