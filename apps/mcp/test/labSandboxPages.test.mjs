/**
 * A Lab test chat reads web pages for real, as production's turns and jobs do, and never reaches a browser
 * (`labSandbox/policy.js` `readOnlySiteShots`; docs/decisions/texting-assistant/lab-sandbox.md). Before 2026-11-18 the
 * screenshot Worker was cut from a test turn's env whole, so `open_page` was never offered: a Lab job called it as a
 * send action for three parts and said the sites "weren't readable from this job".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxEnvOf } from "../src/labSandbox/policy.js";
import { computerFor, webSession } from "../../../packages/tex/gateway/agent/computer.js";

test("a test turn reads pages through the screenshot Worker, and never reaches its browser", async () => {
  const reached = [];
  const shots = { fetch: async (url, init) => (reached.push(new URL(url).pathname), new Response(JSON.stringify({ page: { url: "https://example.com/", title: "Example", text: "Day pass 5000" } }))) };
  const out = sandboxEnvOf({ SITE_SHOTS: shots }, { gate: { record() {} } });
  assert.notEqual(out.SITE_SHOTS, shots, "never the real binding as it is");
  for (const path of ["/read", "/shoot", "/render"]) assert.equal((await out.SITE_SHOTS.fetch(`https://site-shots${path}`, { method: "POST", body: "{}" })).status, 200, path);
  for (const path of ["/browse", "/browse/close", "/browse/hold", "/browse/release", "/browse/log", "/view/frame", "/view/input", "/view/status"]) {
    assert.equal((await out.SITE_SHOTS.fetch(`https://site-shots${path}`, { method: "POST", body: "{}" })).status, 403, path);
  }
  assert.equal((await out.SITE_SHOTS.fetch("https://site-shots/read", { method: "GET" })).status, 403, "only a POST read");
  assert.deepEqual(reached, ["/read", "/shoot", "/render"]);
  // What a turn's web session is built from: with it, open_page is offered and reads the page (`computer.js`).
  const computer = computerFor(out);
  const session = webSession(computer, "look at https://example.com/");
  assert.ok(session.tools.some((tool) => tool.name === "open_page"), "open_page offered in a test chat");
  const read = await session.call("open_page", { urls: ["https://example.com/"] });
  assert.match(read.content[0].text, /Day pass 5000/);
});
