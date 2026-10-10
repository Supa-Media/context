/**
 * Tex end to end, live against staging, through the texts simulator.
 *
 * Proves what a person texting Tex gets, on the deployed Workers rather than
 * fakes: the seeded alpha@supa.media persona links a fictional 555-01XX number
 * (the simulator's only numbers) with a code from the app's own action, then
 * texts a quick question, a long task and a browser task, and the run reads
 * the replies the way the simulator page does. The long task must come back with more than one
 * text (progress, then the result) and never "Something went wrong".
 *
 * The transcript is printed: it is a staging persona's fixture notes and a
 * public web page, nothing real. The phone is unlinked at the end, whatever
 * happened.
 *
 * Needs APP_ENV=staging, STAGING_CONVEX_DEPLOYMENT, and TEX_SIMULATOR_ORIGIN
 * (the staging agent Worker's origin, which the workflow derives and masks).
 */

import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const PERSONA = "alpha@supa.media";
const CODE = "000000";
const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
const origin = (process.env.TEX_SIMULATOR_ORIGIN ?? "").replace(/\/+$/, "");
assert.equal(process.env.APP_ENV, "staging", "APP_ENV must be staging");
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment), "STAGING_CONVEX_DEPLOYMENT is required");
assert.ok(/^https:\/\/[^\s/]+$/.test(origin), "TEX_SIMULATOR_ORIGIN is required");

const ref = (name) => makeFunctionReference(name);
const key = randomBytes(32).toString("hex");
const phone = `+1415555${String(100 + randomInt(100)).padStart(4, "0")}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (label) => console.log(`PASS  ${label}`);

async function sim(action, body) {
  const url =
    action === "thread"
      ? `${origin}/texts-simulator/api/thread?phone=${encodeURIComponent(phone)}`
      : `${origin}/texts-simulator/api/${action}`;
  const response = await fetch(url, {
    method: action === "thread" ? "GET" : "POST",
    headers: { "x-simulator-key": key, "content-type": "application/json" },
    body: action === "thread" ? undefined : JSON.stringify({ phone, ...body }),
  });
  assert.ok(response.ok, `simulator ${action} answered ${response.status}`);
  return response.json();
}

/** Text Tex and wait until it has stopped typing; returns the texts it sent back. */
async function text(message, { timeoutMs = 3 * 60_000 } = {}) {
  const before = (await sim("thread")).messages.length;
  const sent = Date.now();
  await sim("send", { text: message });
  console.log(`\n> ${message}`);
  let printed = before + 1;
  for (;;) {
    await pause(2000);
    const thread = await sim("thread");
    for (const entry of thread.messages.slice(printed)) {
      console.log(`< [${Math.round((entry.at - sent) / 1000)}s] ${entry.text}`);
    }
    printed = Math.max(printed, thread.messages.length);
    if (!thread.typing && thread.messages.length > before + 1) {
      return thread.messages.slice(before + 1).filter((entry) => entry.dir === "in").map((entry) => entry.text);
    }
    assert.ok(Date.now() - sent < timeoutMs, `no reply to "${message}" within ${timeoutMs / 1000}s`);
  }
}

const convex = new ConvexHttpClient(`https://${deployment}.convex.cloud`, { logger: false });
await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA } });
const signedIn = await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA, code: CODE } });
assert.ok(signedIn.tokens?.token, "persona sign-in failed");
convex.setAuth(signedIn.tokens.token);
pass("signed in as the alpha persona");

let failed = null;
try {
  const { code } = await convex.action(ref("functions/textLinks:startPhoneLink"), { phone });
  const linked = await text(`link ${code}`, { timeoutMs: 60_000 });
  assert.ok(linked.some((reply) => /Tex/.test(reply) && /connected/.test(reply)), `link reply: ${linked.join(" | ")}`);
  pass("a fictional number links with the app's code, and Tex introduces itself");

  const quick = await text("Hey, what are you?");
  assert.ok(quick.length >= 1 && !quick.some((reply) => /Something went wrong/.test(reply)), "quick answer failed");
  pass("a quick question is answered");

  const long = await text(
    "Find the opening hours of the Louvre on the web, then save them to a new note in my inbox called louvre-hours.md, and tell me when it's done.",
    { timeoutMs: 11 * 60_000 },
  );
  assert.ok(!long.some((reply) => /Something went wrong/.test(reply)), `long task failed: ${long.join(" | ")}`);
  assert.ok(long.length >= 2, `a long task should text progress before its result, got: ${long.join(" | ")}`);
  pass("a long task texts progress and then its result");

  // The browser (apps/mcp/src/agent/browse.js): a site's own search box,
  // typed with the person's words, then the answer read off the result.
  const browsed = await text(
    "Go to wikipedia.org, type Ada Lovelace into its search box and open her article, then tell me the year she was born.",
    { timeoutMs: 6 * 60_000 },
  );
  assert.ok(browsed.some((reply) => /1815/.test(reply)), `browsing reply: ${browsed.join(" | ")}`);
  pass("Tex drives a browser: types into a site's search and reads the result");
} catch (error) {
  failed = error;
} finally {
  try {
    await text("unlink", { timeoutMs: 60_000 });
    console.log("Unlinked the fictional number.");
  } catch (error) {
    console.log(`Could not unlink: ${error.message}`);
  }
}
if (failed) throw failed;
