/**
 * A TURN THAT ENDS WAITING ON THE PERSON HOLDS ITS BROWSER (Dev2, 2026-10-28).
 *
 * Tex asks for the code a site just sent, and the person answers eight
 * minutes later: the five-minute release had already closed the page, so Tex
 * signed in again from the start. Such a turn now asks the screenshot Worker
 * to hold the Browserbase browser fifteen minutes (`browserHold.js`).
 *
 * ## Sabotage record
 *
 *   `closeBrowser` ignoring `waiting`
 *     → "a Browserbase turn waiting on a code holds its browser" fails
 *   `waitsOnThem` true for any question
 *     → "an ordinary answer or question holds nothing" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";
import { waitsOnThem } from "../src/agent/browserHold.js";

const OWNER = "a".repeat(64);

function binding() {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ path: new URL(url).pathname, ...body });
      if (body.provider === "browserbase") return Response.json({ session: "bb-1", ran: [{ do: "read", ok: true }], page: null });
      return Response.json({ session: "cf-1", ran: [{ do: "read", ok: true }], page: { url: "https://x.example/", title: "X", text: "", elements: [] } });
    },
  };
}

test("a turn asking for something only they can give waits on them", () => {
  for (const answer of [
    "Instacart just sent a 6-digit code to your phone. What is it?",
    "I'm on the sign-in page. Text me the verification code when it arrives.",
    "Can you send me the code from your authenticator app?",
    "There's a picture captcha I couldn't get past. Can you solve it?",
  ]) assert.equal(waitsOnThem(answer), true, answer);
  assert.equal(waitsOnThem("Done.", { vaultLink: true }), true);
});

test("an ordinary answer or question holds nothing", () => {
  for (const answer of [
    "Your groceries are ordered and arrive at 6pm.",
    "Do you want the 2% milk or whole?",
    "I signed in with your saved login and added the wings.",
    "",
  ]) assert.equal(waitsOnThem(answer), false, answer);
});

test("a Browserbase turn waiting on a code holds its browser", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER });
  await computer.browse(null, [{ do: "read" }]);
  await computer.closeBrowser("bb-1", { waiting: true });
  assert.deepEqual(SITE_SHOTS.requests.at(-1), { path: "/browse/hold", provider: "browserbase", owner: OWNER });
});

test("a Browserbase turn not waiting leaves the browser to its own five minutes", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER });
  await computer.browse(null, [{ do: "read" }]);
  await computer.closeBrowser("bb-1", { waiting: false });
  await computer.closeBrowser("bb-1");
  assert.deepEqual(SITE_SHOTS.requests.map((r) => r.path), ["/browse"]);
});

test("Cloudflare's browser closes with its question, waiting or not", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const computer = siteShotsComputer({ SITE_SHOTS }, {});
  await computer.browse(null, [{ do: "read" }]);
  await computer.closeBrowser("cf-1", { waiting: true });
  assert.equal(SITE_SHOTS.requests.at(-1).path, "/browse/close");
  assert.equal(SITE_SHOTS.requests.some((r) => r.path === "/browse/hold"), false);
});
